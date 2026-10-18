// The 'pseudo' locale (T48): generated from en/messages.json, not hand-authored or checked in as
// static translated JSON. Every English string is wrapped in Unicode bidi override marks, which
// forces the browser to render the literal Latin text right-to-left without needing a real
// RTL-script translation — the same technique as Microsoft's "mirrored pseudo locale"
// (qps-plocm). Deriving it from English by construction means its key set can never drift out of
// sync as later tasks add keys to messages.json; a separate consistency check for it would be
// redundant.
import enMessages from '../en/messages.json'

const RLO = '‮' // RIGHT-TO-LEFT OVERRIDE
const PDF = '‬' // POP DIRECTIONAL FORMATTING

const pseudoMessages: Record<string, string> = Object.fromEntries(
  Object.entries(enMessages).map(([key, value]) => [key, `${RLO}${value}${PDF}`]),
)

export default pseudoMessages
