// @flow

import { TYPE_CALL, TYPE_RESOLVE, TYPE_REJECT, TYPE_DESCRIPTOR } from './constants'

export type SerialProp = {
  path: string,
  node: any
}

export type SerialMethod = {
  path: string,
  key: string
}

export type RemoteDescriptor = {
  type: typeof TYPE_DESCRIPTOR,
  methods: Array<SerialMethod>,
  props: Array<SerialProp>,
  nonce: string,
  sessionId?: string,
}

export type CallPayload = {|
  type: typeof TYPE_CALL,
  callId: string,
  methodKey: string,
  args: Array<any>,
  authentication: ?string,
  signature: ?string,
  sessionId: ?string
|}

export type ResolvePayload = {|
  type: typeof TYPE_RESOLVE,
  callId: string,
  value: any
|}

export type RejectPayload = {|
  type: typeof TYPE_REJECT,
  callId: string,
  catch: string,
  stack: any
|}

export type Payload =
  | RemoteDescriptor
  | CallPayload
  | ResolvePayload
  | RejectPayload
