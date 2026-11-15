import json
from pathlib import Path

from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent
schema = json.loads((root / "policy.schema.json").read_text(encoding="utf-8"))
example = json.loads((root / "policy.example.json").read_text(encoding="utf-8"))

Draft202012Validator.check_schema(schema)
Draft202012Validator(schema).validate(example)
print("schema+example ok")
