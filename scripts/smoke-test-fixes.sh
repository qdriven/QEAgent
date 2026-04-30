#!/bin/bash
# End-to-end smoke test for all 4 MCP bug fixes via fresh MCP server.
# Spawns the MCP server, sends JSON-RPC requests, and asserts on results.
#
# Bug coverage:
#   #1 — temp-path leak in generated test imports
#   #2 — framework param honored AND emits valid jest imports
#   #3 — coverage_analyze_sublinear no longer blocked by governance throttle
#   #4 — qe/coverage/gaps error message clearly distinguishes coverageFile vs autodiscovery

set -u
BUNDLE="/workspaces/agentic-qe/dist/mcp/bundle.js"

if [ ! -f "$BUNDLE" ]; then
  echo "MCP bundle not found at $BUNDLE — run npm run build:mcp first" >&2
  exit 2
fi

# Build a real Istanbul coverage fixture (non-empty)
FIXTURE=/tmp/aqe-smoke-coverage-$$.json
cat > "$FIXTURE" <<'EOF'
{
  "/tmp/sample.ts": {
    "path": "/tmp/sample.ts",
    "statementMap": {"0": {"start": {"line": 1}, "end": {"line": 1}}, "1": {"start": {"line": 5}, "end": {"line": 5}}},
    "fnMap": {"0": {"name": "f", "decl": {"start": {"line": 1}}, "loc": {"start": {"line": 1}}}},
    "branchMap": {},
    "s": {"0": 5, "1": 0},
    "f": {"0": 5},
    "b": {}
  }
}
EOF

EMPTY=/tmp/aqe-smoke-empty-$$.json
echo '{}' > "$EMPTY"

OUT=/tmp/aqe-smoke-out-$$.log

(
  # init
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'

  # Bug #2 verification: test_generate_enhanced with framework=jest must accept the param
  # AND emit valid @jest/globals imports (not the broken `from 'jest'` form)
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"test_generate_enhanced","arguments":{"sourceCode":"export function add(a:number,b:number):number{return a+b;}","language":"typescript","testType":"unit","framework":"jest"}}}'

  # Bug #4a: empty coverageFile — error must reference the file path
  echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"qe/coverage/gaps\",\"arguments\":{\"target\":\"src/\",\"coverageFile\":\"$EMPTY\"}}}"

  # Bug #4b: valid coverageFile — must succeed
  echo "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"qe/coverage/gaps\",\"arguments\":{\"target\":\"src/\",\"coverageFile\":\"$FIXTURE\",\"minRisk\":0}}}"

  # Bug #3: coverage_analyze_sublinear must NOT be blocked by governance
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"coverage_analyze_sublinear","arguments":{"target":"src/shared","detectGaps":false}}}'

  # Bug #1: test_generate_enhanced with sourceCode-only (no filePath) — emitted
  # tests must NOT reference /tmp/aqe-temp paths
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"test_generate_enhanced","arguments":{"sourceCode":"export function multiply(a:number,b:number):number{return a*b;}","language":"typescript","testType":"unit","framework":"vitest"}}}'

  sleep 14
) | timeout 120 node "$BUNDLE" 2>/dev/null > "$OUT"

# Parse results and assert. Single sys.exit at the end to avoid the
# silently-caught-SystemExit bug from the earlier version.
python3 <<EOF
import json, re, sys

results = {}
with open('$OUT') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if 'id' not in msg: continue
        if 'result' in msg:
            results[msg['id']] = msg['result']
        elif 'error' in msg:
            results[msg['id']] = {'error': msg['error']}

def get_text(rid):
    r = results.get(rid)
    if not r: return ''
    content = r.get('content', [])
    if not content: return ''
    return content[0].get('text', '')

passes = []
fails = []

# === Bug #2: test_generate_enhanced accepts framework=jest AND emits valid jest imports ===
text2 = get_text(2)
if not text2:
    fails.append('bug #2: no response from test_generate_enhanced')
elif 'Budget acceleration' in text2 or 'blocked by governance' in text2:
    fails.append(f'bug #3 (still blocking test_generate): {text2[:200]}')
else:
    try:
        data = json.loads(text2)
        if not data.get('success'):
            fails.append(f'bug #2: tool returned error: {data.get("error", text2[:150])}')
        else:
            tests = data.get('data', {}).get('tests', [])
            if not tests:
                fails.append('bug #2: no tests in response')
            else:
                code = tests[0].get('testCode', '')
                # The original bug: emitted from-jest import which fails at runtime
                if re.search(r"from\s+['\"]jest['\"]", code):
                    fails.append(f'bug #2: still emits invalid jest-package import:\n{code[:300]}')
                elif "@jest/globals" not in code:
                    fails.append(f'bug #2: jest framework requested but @jest/globals not in imports:\n{code[:300]}')
                else:
                    passes.append('bug #2: framework=jest accepted and emits valid @jest/globals imports')
    except json.JSONDecodeError:
        fails.append(f'bug #2: response not JSON: {text2[:200]}')

# === Bug #4a: empty coverageFile — error must reference the file ===
text3 = get_text(3)
if '$EMPTY' in text3 and 'contains no usable coverage data' in text3:
    passes.append('bug #4a: empty coverageFile error references the file path')
else:
    fails.append(f'bug #4a: error did not reference coverageFile: {text3[:200]}')

# === Bug #4b: valid coverageFile must succeed ===
text4 = get_text(4)
try:
    data4 = json.loads(text4)
    if data4.get('success'):
        passes.append('bug #4b: valid coverageFile succeeds')
    else:
        fails.append(f'bug #4b: valid file rejected: {data4.get("error")}')
except json.JSONDecodeError:
    fails.append(f'bug #4b: response not JSON: {text4[:200]}')

# === Bug #3: coverage_analyze_sublinear must NOT be blocked by governance ===
text5 = get_text(5)
if 'Budget acceleration' in text5 or 'blocked by governance' in text5:
    fails.append(f'bug #3: still blocked by governance: {text5[:200]}')
elif text5:
    passes.append('bug #3: coverage_analyze_sublinear no longer blocked by governance throttle')
else:
    fails.append('bug #3: no response')

# === Bug #1: generated test imports must NOT reference /tmp/aqe-temp ===
text6 = get_text(6)
try:
    data6 = json.loads(text6)
    if not data6.get('success'):
        fails.append(f'bug #1: tool errored: {data6.get("error")}')
    else:
        tests = data6.get('data', {}).get('tests', [])
        if not tests:
            fails.append('bug #1: no tests returned')
        else:
            code = tests[0].get('testCode', '')
            if '/tmp/aqe-temp' in code:
                fails.append(f'bug #1: testCode still references /tmp/aqe-temp:\n{code[:400]}')
            elif 'module-under-test' not in code:
                fails.append(f'bug #1: placeholder missing from generated code:\n{code[:400]}')
            else:
                passes.append('bug #1: no temp-path leak; placeholder + TODO present')
except json.JSONDecodeError:
    fails.append(f'bug #1: response not JSON: {text6[:200]}')

# Single point of exit
print()
for p in passes:
    print(f'PASS {p}')
for f in fails:
    print(f'FAIL {f}')
print()
print(f'=== {len(passes)} passed, {len(fails)} failed ===')
sys.exit(0 if not fails else 1)
EOF

RC=$?
rm -f "$FIXTURE" "$EMPTY" "$OUT"
exit $RC
