---
"@open-rgs/core": patch
---

Docs: remove every remaining reference to the Lua tier and simplify the prose
around it.

Spec 03 loses its Lua runtime section, its sandbox denylist and the wasmoon
boundary discussion; spec 06 loses the Lua latency and throughput rows and the
LuaJIT-via-FFI open questions. The site's `/extend` page had a whole section on
`LuaExtension` - a registration contract, a prelude source transform, host
bridging - which is replaced by three lines saying a library is an ordinary
import. Package and example READMEs, the JSON-LD `programmingLanguage`, and the
error-redaction fixtures all follow.

Also fixed on the way through: three stale links to `@open-rgs/ext-reels`, now
pointing at the slot libraries at `/extension`.
