// @flow

export type SerialProp = {
  path: string,
  node: any
}

export type SerialMethod = {
  path: string,
  key: string
}

export type RemoteDescriptor = {
  type: "RemoteDescriptor",
  methods: Array<SerialMethod>,
  props: Array<SerialProp>,
  nonce: string,
  sessionId?: string,
}

export type CallPayload = {|
  type: "Call",
  callId: string,
  methodKey: string,
  args: Array<any>,
  authentication: ?string,
  signature: ?string,
  sessionId: ?string
|}

export type ResolvePayload = {|
  type: "Resolve",
  callId: string,
  value: any
|}

export type RejectPayload = {|
  type: "Reject",
  callId: string,
  catch: string,
  stack: any
|}

export type Payload =
  | RemoteDescriptor
  | CallPayload
  | ResolvePayload
  | RejectPayload
