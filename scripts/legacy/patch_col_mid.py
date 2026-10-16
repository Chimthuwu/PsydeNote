import re

with open("spike/elementary/ui/plugin-ui.css", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update .op-col-mid to avoid space-between which pushes the bottom item all the way down
content = re.sub(
    r'\.op-col-mid \{.*?\}',
    r'.op-col-mid { gap: 6px; justify-content: flex-start; padding-top: 8px; }',
    content,
    flags=re.DOTALL
)

# 2. Remove the old transform hacks that don't make sense with the new layout
content = re.sub(
    r'\.op-col-mid > \.op-mod-cluster:first-child \{.*?\}',
    '',
    content,
    flags=re.DOTALL
)
content = re.sub(
    r'\.op-col-mid > \.op-mod-cluster \+ \.op-mod-cluster \{.*?\}',
    '',
    content,
    flags=re.DOTALL
)

with open("spike/elementary/ui/plugin-ui.css", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
