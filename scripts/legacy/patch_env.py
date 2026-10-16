import re

with open("spike/elementary/ui/plugin-ui.css", "r", encoding="utf-8") as f:
    content = f.read()

pattern = re.compile(r'\.env-grid \{\s*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);\s*justify-content: start;\s*\}')

new_str = """.env-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-template-rows: 66px 66px 140px;
  justify-content: start;
}"""

content = pattern.sub(new_str, content)

with open("spike/elementary/ui/plugin-ui.css", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
