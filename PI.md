# pi-mistral-bridge

A Pi extension that exposes Mistral models inside Pi by driving your own
installed Mistral Vibe harness (`vibe-acp`) over the Agent Client Protocol
(ACP). Provider mode puts the models `vibe-acp` reports into Pi's model picker
with Pi owning the agent loop and executing every tool call; the `ask_vibe`
tool delegates self-contained tasks to Vibe as a sub-agent. The bridge never
calls the Mistral API directly and never touches Vibe's credentials — it talks
to Mistral only through your own `vibe-acp` process. See
[README.md](README.md) for installation, configuration, both modes, security
notes and troubleshooting.
