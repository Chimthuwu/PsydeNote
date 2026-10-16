import re

with open("spike/elementary/ui/plugin-ui.css", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    "  grid-template-rows: 66px 66px 140px;\n",
    ""
)

with open("spike/elementary/ui/plugin-ui.css", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
