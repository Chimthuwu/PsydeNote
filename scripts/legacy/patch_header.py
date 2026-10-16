import re

with open("spike/elementary/ui/PluginApp.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Replace the header right section
pattern_header = re.compile(r'<PresetBar synth=\{synth\} onChange=\{\(patch\) => change\(patch\.synth \?\? \{\}\)\} />\s*<span className="plugin-zoom".*?⏹\s*</button>', re.DOTALL)

macros_jsx = """
            <div className="plugin-macros" role="list" aria-label="Macros">
              {MACRO_IDS.map((source, i) => (
                <span key={source} className="plugin-macro" role="listitem"
                  style={{ '--src': MOD_SOURCES[source].color } as React.CSSProperties}>
                  <SourceDot
                    source={source}
                    armed={assignSource === source}
                    onSourceDragStart={handleSourceDragStart}
                    onSourceContext={openSourceRoutes}
                  />
                  <Knob
                    value={synth.macros[i] ?? 0}
                    min={0}
                    max={1}
                    size="sm"
                    color={MOD_SOURCES[source].color}
                    onChange={(v) => setMacro(i, v)}
                    format={(v) => Math.round(v * 100).toString()}
                    title={`${MOD_SOURCES[source].label} — drag to set; drag its dot onto a knob to route it`}
                  />
                </span>
              ))}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
              <PresetBar synth={synth} onChange={(patch) => change(patch.synth ?? {})} />
            </div>
"""

content = pattern_header.sub(macros_jsx, content)

# 2. Modify renderFxChain to ONLY render FxChainStrip
pattern_fx_chain = re.compile(r'renderFxChain=\{.*?<FxChainStrip', re.DOTALL)
# Wait, let's find the exact renderFxChain string
pattern_render = re.compile(r'renderFxChain=\{\(\) => \(\s*<div className="fx-macro-column">\s*<div className="plugin-macros".*?</div>\s*<FxChainStrip\s*(.*?)\s*/>\s*</div>\s*\)\}', re.DOTALL)
# Let's replace the whole block
# Wait, if I just replace `<div className="fx-macro-column">...</div>` with just `<FxChainStrip ... />`
# Actually, it's safer to just write a simple regex or do a string replace

new_render_fx_chain = """renderFxChain={() => (
                  <FxChainStrip
                    fx={synth.fx}
                    onChange={change}
                    view={view}
                    onToggleView={() => setViewPersist(view === 'osc' ? 'fx' : 'osc')}
                    anyFxWet={anyFxWet}
                  />
                )}"""

content = re.sub(
    r'renderFxChain=\{\(\) => \(\s*<div className="fx-macro-column">\s*<div className="plugin-macros".*?</div>\s*<FxChainStrip(.*?)\/>\s*</div>\s*\)\}',
    r'renderFxChain={() => (\n                  <FxChainStrip\1/>\n                )}',
    content,
    flags=re.DOTALL
)

with open("spike/elementary/ui/PluginApp.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
