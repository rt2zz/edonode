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
  props: Array<SerialProp>
}

type CallPayload = {
  type: "Call",
  callId: string,
  methodKey: string,
  args: Array<any>,
  accessToken: string,
  connectionId: string
}

type ResolvePayload = {
  type: "Resolve",
  callId: string,
  value: any
}

type RejectPayload = {
  type: "Reject",
  callId: string,
  catch: string,
  stack: any
}

type IdentifyPayload = {
  type: "Identify",
  connectionId: string
}

export type Payload =
  | RemoteDescriptor
  | CallPayload
  | ResolvePayload
  | RejectPayload
  | IdentifyPayload
