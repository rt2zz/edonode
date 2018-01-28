// @flow
import msgpackStream from "msgpack5-stream"
import traverse from "traverse"
import _ from "lodash"
import Backoff from "backo"
import uuidv4 from "uuid/v4"
import type { Duplex } from "stream"

import type { CallPayload, IdentifyPayload, Payload, RejectPayload, RemoteDescriptor, ResolvePayload, SerialMethod, SerialProp } from "./types"

type PromisyGetterThing = string | (() => string) | (() => Promise<string>)
type GetAuthentication = PromisyGetterThing
export type Remote<Face> = {
  (): Promise<Face>,
  authenticate: (getAuthentication: GetAuthentication) => void
}

const sleepReject = async (timeout: number) =>
  new Promise((resolve, reject) => setTimeout(reject, timeout))

export let connectionRegistry: Map<string, any> = new Map()

type BaseStream = () => Duplex | Object
type Options = {
  autoReconnect?: boolean,
  debug?: boolean,
  key: string,
  connectionId?: PromisyGetterThing,
}
type Context = { getAuthentication: ?GetAuthentication }
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

  let _context: Context = {
    getAuthentication: null
  }

  // #plumbing
  const onConnect = ({ rpc }) => {
    _rpc = rpc
    backoff.reset()
    return rpc
  }

  const requestReconnect = () => {
    // if reconnect alreay pending, noop
    if (_connectTimeout) return

    _rpc = null
    _rpcPromise = null
    const wait = backoff.duration()
    console.log("requestReconnect, connecting in", wait, _connectTimeout)
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
    stream.on("open", e => {
      if (options.debug) console.log("OPEN", e)
    })

    stream.on("error", err => {
      if (options.debug) console.log("Stream ERR", err)
      if (options.autoReconnect) requestReconnect()
    })

    stream.on("close", e => {
      if (options.debug) console.log("Stream CLOSE", e)
      if (options.autoReconnect) requestReconnect()
      else console.log("## stream closed, is cleanup required?")
    })
  }

  // #init @TODO should we remove this and have it be lazy?
  connect()

  function remote(timeout: number = 500) {
    if (_rpc) return _rpc
    // @TODO implement reconnect logic
    return Promise.race([
      // @NOTE if there is no rpcPromise, connect immediately. Should this automatic behavior be replaced by an explicit control?
      _rpcPromise || connect(),
      sleepReject(timeout)
    ])
  }

  remote.authenticate = (getAuthentication: GetAuthentication) => {
    _context.getAuthentication = getAuthentication
  }

  return remote
}

type RemoteDescriptors = {
  methods: Array<SerialMethod>,
  props: Array<SerialProp>
}

function prepareRPC(rpc): [Map<string, Function>, RemoteDescriptors] {
  let methods = []
  let props = []
  let registry = new Map()
  traverse(rpc).forEach(function(node) {
    if (typeof node === "function") {
      let key = Math.random().toString()
      methods.push({ path: this.path, key })
      registry.set(key, node)
    } else {
      props.push({ path: this.path, node })
    }
  })
  let remoteDescriptor: RemoteDescriptor = { type: "RemoteDescriptor", methods, props }
  return [registry, remoteDescriptor]
}

// @NOTE flow stream type does not understand object mode streams
function connectRpc(
  _stream: any,
  _context: Context,
  rpc: ?Object,
  options: Options
): Promise<Object> {
  let stream = msgpackStream(_stream)
  let remotes = {}

  const [localRegistry, remoteDescriptor] = prepareRPC(rpc)
  const callPromises: Map<string, { resolve: Function, reject: Function }> = new Map()
  // send the description of our available rpc immediately
  stream.write(remoteDescriptor)
  
  // attempt to identify asap
  async function identify () {
    let realizedConnectionId = typeof options.connectionId === 'function' ? await options.connectionId() : options.connectionId
    if (realizedConnectionId) {
      let identifyPayload: IdentifyPayload = { type: "Identify", connectionId: realizedConnectionId }
      stream.write(identifyPayload)
    }
  }
  identify()
    

  const callRemote = async (methodKey, ...args) => {
    // @TODO more efficient way than attaching to every call? it can already be closed over in the stream
    let connectionId = typeof options.connectionId === 'function' ? await options.connectionId() : options.connectionId

    return new Promise(async (resolve, reject) => {
      let callId = Math.random().toString()
      callPromises.set(callId, { resolve, reject })
      let call: CallPayload = {
        type: "Call",
        callId,
        methodKey,
        args,
        authentication: typeof _context.getAuthentication === 'function' ? await _context.getAuthentication() : _context.getAuthentication,
        connectionId
      }
      stream.write(call)
    })
  }

  const parseRPC = (data: RemoteDescriptor) => {
    let mkmethod = methodKey => {
      return async (...args) => callRemote(methodKey, ...args)
    }
    data.methods.forEach(m => {
      _.set(remotes, m.path, mkmethod(m.key))
    })
    data.props.forEach(p => {
      _.set(remotes, p.path, p.node)
    })
    return remotes
  }

  return new Promise((resolveConnect, rejectConnect) => {
    stream.on("data", async (payload: Payload) => {
      if (payload.type === "Identify") {
        console.log("SET REMOTE", payload.connectionId)
        connectionRegistry.set(registryKey(options.key, payload.connectionId), remotes)
      } else if (payload.type === "RemoteDescriptor") {
        resolveConnect({ rpc: parseRPC(payload) })
      } else if (payload.type === "Call") {
        if (options.debug) console.log("## Call", payload)
        // @TODO potential optimization by not setting for every call?
        // @TODO cleanup connectionRegistry after disconnect
        let method = localRegistry.get(payload.methodKey)
        if (!method) {
          console.error("Missing required method", payload)
          return
        }

        try {
          let value = await method.apply(payload, payload.args)
          let resolvePayload: ResolvePayload =  {
            type: "Resolve",
          callId: payload.callId,
          value
        }
          stream.write(resolvePayload)
        } catch (err) {
          let rejectPayload: RejectPayload = {
            type: "Reject",
            callId: payload.callId,
            catch: err.message,
            stack: err.stack
          }
          stream.write(rejectPayload)
        }
      } else if (payload.type === "Resolve") {
        let { resolve } = callPromises.get(payload.callId) || {}
        if (!resolve) {
          console.error("Missing required callPromise", payload)
          return
        }
        resolve(payload.value)
        callPromises.delete(payload.callId)
      } else if (payload.type === "Reject") {
        let { reject } = callPromises.get(payload.callId) || {}
        if (!reject) {
          console.error("Missing required callPromise", payload)
          return
        }
        let e = new Error(payload.catch)
        e.stack = payload.stack
        reject(e)
        callPromises.delete(payload.callId)
      }
    })
    stream.on("error", (err, data) => {
      console.log("##########@@ remote error", err, data)
    })
    stream.on("close", (err, data) => {
      console.log("##########@@ remote close", err, data)
    })
  })
}

function registryKey(key: string, connectionId: string) {
  return key + "::" + connectionId
}

export default edonode
export function getLocalRemote(key: string, connectionId: string): any {
  console.log("GET REMOTE", connectionRegistry, key, connectionId)
  return connectionRegistry.get(registryKey(key, connectionId))
}
