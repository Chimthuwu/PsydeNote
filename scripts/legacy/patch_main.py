import re

with open("spike/elementary/ui/main.tsx", "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace("(1.2 / dpr)", "(1.0 / dpr)")

with open("spike/elementary/ui/main.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
