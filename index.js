// @flow
import jsonStream from "json-lpduplex-stream"
import traverse from "traverse"
import { memoize as _memoize, set as _set } from "lodash"
import Backoff from "backo"
import uuidv4 from "uuid/v4"
import serializeError from 'serialize-error'
import type { Duplex } from "stream"

import type { CallPayload, Payload, RejectPayload, RemoteDescriptor, ResolvePayload, SerialMethod, SerialProp } from "./types"

import { RemoteError } from './utils'
import { TYPE_CALL, TYPE_RESOLVE, TYPE_REJECT, TYPE_DESCRIPTOR } from './constants'
export const SIGN_TYPE_NONCE = "nonce"
const NONCE_NOT_INITIALIZED = 'NONCE_NOT_INITIALIZED'

type PromisyGetterThing = string | (() => string) | (() => Promise<string>)
type Authenticator = PromisyGetterThing
type Signer = (string) => Promise<string>
type SignerOptions = {
  type: typeof SIGN_TYPE_NONCE,
}
export type Remote<Face> = {
  (): Promise<Face>,
  auth: (authenticator: Authenticator) => void,
  sign: (signer: Signer, options: SignerOptions) => void
}

const sleepReject = async (timeout: number, label?: string) =>
  new Promise((resolve, reject) => setTimeout(() => reject(new Error(`edonode: ${label || ''} connection timed out after ${timeout}ms`)), timeout))

export let connectionRegistry: Map<string, any> = new Map()

type BaseStream = () => Duplex | Object
type VerifyTypeNonce = (nonce: string, signature: any) => (void | Promise<void>)
type Options = {|
  autoReconnect?: boolean,
  debug?: boolean,
  duplexSerializer?: Function,
  name?: string,
  onStreamEvents?: {
    onOpen?: (Object) => any,
    onClose?: (Object) => any,
    onError?: (Object) => any,
  },
  sessionId?: PromisyGetterThing,
  timeout?: number,
  verify?: VerifyTypeNonce,
|}
type ContextMethod<F, O> = {
  v?: F,
  options?: O,
}
type Context = { auth: ContextMethod<Authenticator, void>, sign: ContextMethod<Signer, SignerOptions>, remoteNonce: string, }
// @NOTE return type any, not sure how to proxy the Face type through
function edonode(baseStream: BaseStream, rpc: Object | void, options: Options): any {
  // #validations
  if (options.autoReconnect && typeof baseStream !== "function")
    throw new Error("edonode: autoReconnect requires stream be a factory")

  // #private variables
  const backoff = new Backoff({ min: 1000, max: 600000 })
  let _stream
  let _rpc
  let _rpcPromise
  let _connectTimeout

  // @NOTE default name to the baseStream name
  options.name = options.name || baseStream.name

  let _context: Context = {
    auth: { },
    sign: { },
    remoteNonce: NONCE_NOT_INITIALIZED,
  }

  // #plumbing
  const onConnect = ({ rpc, nonce }) => {
    _rpc = rpc
    _context.remoteNonce = nonce
    backoff.reset()
    return rpc
  }

  const requestReconnect = error => {
    if (options.debug && error) console.error("edonode: requestReconnect, error: ", error)
    // if reconnect alreay pending, noop
    if (_connectTimeout) return

    _rpc = null
    _rpcPromise = null
    const wait = backoff.duration()
    if (options.debug) console.log("edonode: requestReconnect, connecting in", wait, _connectTimeout)
    _connectTimeout = setTimeout(connect, wait)
  }

  const connect = () => {
    // clear any scheduled connect
    _connectTimeout !== null && clearTimeout(_connectTimeout)
    _connectTimeout = null

    _stream = typeof baseStream === "function" ? baseStream() : baseStream
    monitorStream(_stream)
    _rpcPromise = connectRpc(_stream, _context, rpc, options)
      .then(onConnect)
      .catch(requestReconnect)
    return _rpcPromise
  }

  function monitorStream(stream) {
    // #stream monitoring
    let onStreamEvents = options.onStreamEvents || {}
    stream.on("open", e => {
      if (onStreamEvents.onOpen) onStreamEvents.onOpen(e)
      if (options.debug) console.log("edonode: stream open", e)
    })

    stream.on("error", e => {
      if (onStreamEvents.onError) onStreamEvents.onError(e)
      if (options.debug) console.log("edonode: stream err", e)
      if (options.autoReconnect) requestReconnect()
    })

    stream.on("close", e => {
      if (onStreamEvents.onClose) onStreamEvents.onClose(e)
      if (options.debug) console.log("edonode: stream close", e)
      if (options.autoReconnect) requestReconnect()
      // else: stream closed now, is cleanup required?
    })
  }

  // #init @TODO should we remove this and have it be lazy?
  connect()

  function remote(timeout: number = options.timeout || 500) {
    if (_rpc) return _rpc
    // @TODO implement reconnect logic
    return Promise.race([
      // @NOTE if there is no rpcPromise, connect immediately. Should this automatic behavior be replaced by an explicit control?
      _rpcPromise || connect(),
      sleepReject(timeout, options.name)
    ])
  }

  remote.auth = (authenticator: Authenticator) => {
    if (_context.auth.v) throw new Error('edonode: hot swapping auth is not currently supported')
    _context.auth = { v: authenticator }
  }

  remote.sign = async (signer, options = { type: SIGN_TYPE_NONCE }) => {
    if (_context.sign.v) throw new Error('edonode: hot swapping sign is not currently supported')
    // @NOTE this is memoized which means signer need to be deterministic and pure. @TODO anyway to enforce this?
    _context.sign = { v: _memoize(signer), options }
  }

  return remote
}

async function prepareRPC(rpc, options: Options): Promise<[Map<string, { method: Function, path: string }>, RemoteDescriptor]> {
  let methods = []
  let props = []
  let registry = new Map()
  traverse(rpc).forEach(function(node) {
    if (typeof node === "function") {
      let key = Math.random().toString()
      methods.push({ path: this.path, key })
      registry.set(key, { method: node, path: this.path })
    } else {
      props.push({ path: this.path, node })
    }
  })

  let sessionId = typeof options.sessionId === 'function' ? await options.sessionId() : options.sessionId

  let remoteDescriptor: RemoteDescriptor = { type: TYPE_DESCRIPTOR, methods, props, nonce: uuidv4(), sessionId  }
  return [registry, remoteDescriptor]
}

// @NOTE flow stream type does not understand object mode streams
async function connectRpc(
  _stream: any,
  _context: Context,
  rpc: ?Object,
  options: Options
): Promise<Object> {
  let _lastSessionId = null
  let duplexSerializer = options.duplexSerializer || jsonStream
  let stream = duplexSerializer(_stream)
  let remotes = {}
  let remoteMethodNames = {}

  const [localRegistry, remoteDescriptor] = await prepareRPC(rpc, options)
  const callPromises: Map<string, { resolve: Function, reject: Function, methodKey: string }> = new Map()
  
  // send the description of our available rpc immediately
  stream.write(remoteDescriptor)
  
  const callRemote = async (methodKey, ...args) => {
    // @TODO more efficient way than attaching to every call? it can already be closed over in the stream
    let sessionId = typeof options.sessionId === 'function' ? await options.sessionId() : options.sessionId
    return new Promise(async (resolve, reject) => {
      let callId = Math.random().toString()
      callPromises.set(callId, { resolve, reject, methodKey })
      let call: CallPayload = {
        type: TYPE_CALL,
        callId,
        methodKey,
        args,
        sessionId,
        authentication: typeof _context.auth.v === 'function' ?  await _context.auth.v() : _context.auth.v,
        signature: typeof _context.sign.v  === 'function' ? await _context.sign.v(_context.remoteNonce) : _context.sign.v,
      }
      stream.write(call)
    })
  }

  function parseRPC (data: RemoteDescriptor): { rpc: Object, nonce: string } {
    let mkmethod = methodKey => {
      return async (...args) => callRemote(methodKey, ...args)
    }
    data.methods.forEach(m => {
      remoteMethodNames[m.key] = m.path
      _set(remotes, m.path, mkmethod(m.key))
    })
    data.props.forEach(p => {
      _set(remotes, p.path, p.node)
    })
    
    // store connection in registry
    data.sessionId && connectionRegistry.set(data.sessionId, remotes)
    _lastSessionId = data.sessionId

    return { rpc: remotes, nonce: data.nonce }
  }

  return new Promise((resolveConnect, rejectConnect) => {
    stream.on("error", (err) => {
      // @TODO should we expose this to the consumer via a onError callback or similar?
      // @TODO hide this behind options.debug in the future
      console.error("Edonode - Stream Error", err)
    })
    stream.on("data", async (payload: Payload) => {
      if (payload.type === TYPE_DESCRIPTOR) {
        resolveConnect(parseRPC(payload))
      } else if (payload.type === TYPE_CALL) {
        let { method, path } = localRegistry.get(payload.methodKey) || {}
        if (options.debug) console.log(`Edonode - Call - ${path}`, payload)

        // @NOTE we allow sessionId to change on any call. The alternative is we could require the connection be reset completely on sessionId change
        // @TODO cleanup connectionRegistry after disconnect
        if (payload.sessionId !== _lastSessionId) {
          _lastSessionId && connectionRegistry.delete(_lastSessionId)
          _lastSessionId = payload.sessionId
          payload.sessionId && connectionRegistry.set(payload.sessionId, remotes)
        }
        if (!method) {
          console.error("Missing required method", payload)
          return
        }

        try {
          if (payload.signature) {
            // do not allow signature to be provided if the counterparty does not have a verify implemented
            if (!options.verify) throw new Error('edonode: signature was provided but no verify method exists')
            // verifier should confirm the nonce is signed
            // also need to memoize either here or in verifier
            // @TODO implement other verification types. for now only can verify nonce
            else await options.verify(remoteDescriptor.nonce, payload.signature)
          }

          let value = await method.apply(payload, payload.args)
          let resolvePayload: ResolvePayload =  {
            type: TYPE_RESOLVE,
            callId: payload.callId,
            value
          }
          stream.write(resolvePayload)
        } catch (err) {
          let rejectPayload: RejectPayload = {
            type: TYPE_REJECT,
            callId: payload.callId,
            error: serializeError(err)
          }
          stream.write(rejectPayload)
        }
      } else if (payload.type === TYPE_RESOLVE) {
        let { resolve, methodKey } = callPromises.get(payload.callId) || {}
        if (options.debug) console.log(`Edonode - Resolve - ${remoteMethodNames[methodKey]}`, payload)

        if (!resolve) {
          console.error("Missing required callPromise", payload)
          return
        }
        resolve(payload.value)
        callPromises.delete(payload.callId)
      } else if (payload.type === TYPE_REJECT) {
        let { reject, methodKey } = callPromises.get(payload.callId) || {}
        let { error } = payload
        if (options.debug) console.log(`Edonode - Reject - ${remoteMethodNames[methodKey]}`, payload)

        if (!reject) {
          console.error("Missing required callPromise", payload)
          return
        }
        let e = new RemoteError(`remote: ${options.name || ''} - method: ${remoteMethodNames[methodKey]} - message: ${error && error.message}`)
        if (process.env.NODE_ENV !== 'production' && error && error.sourceMessage) console.error('Edonode - sourceMessage already exists in the rejected error, this value will be overwritten.')
        if (error) Object.keys(payload.error).forEach(k => {
          // @NOTE we map error.message to error.sourceMessage
          // $FlowFixMe
          if (k === 'message') e.sourceMessage = error[k]
          // $FlowFixMe
          else e[k] = error[k]
        })
        reject(e)
        callPromises.delete(payload.callId)
      }
    })
  })
}

export default edonode
export function getLocalRemote(sessionId: string): any {
  return connectionRegistry.get(sessionId)
}
