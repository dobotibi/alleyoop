# Windows adapter: manual test (adapter only, no Figma needed)

Windows PowerShell 5.1 (the blue one, not `pwsh`). Illustrator 2024-2026 installed. Send back every output, including errors.

## 0. Unit tests (any OS, needs node)
```
node tests/win/win-adapter.test.js
```

## 1. What is registered?
```
reg query HKCR /f "Illustrator.Application" /k
```
Copy the list. Then for the ProgID that is listed (replace the name):
```
reg query "HKCR\Illustrator.Application\CLSID" /ve
reg query "HKCR\CLSID\<the {GUID} from above>\LocalServer32" /ve
```

## 2. COM by hand (Illustrator closed, then again with Illustrator open)
```
$p = 'Illustrator.Application'      # also try the versioned names from step 1
try { $ai = [Runtime.InteropServices.Marshal]::GetActiveObject($p); 'attached' } catch { 'GetActiveObject: ' + $_.Exception.Message }
if (-not $ai) { $ai = New-Object -ComObject $p; 'created' }
$ai.Version
```

## 3. DoJavaScriptFile by hand
```
$jsx = Join-Path $env:TEMP 'jm-test.jsx'
Set-Content -Path $jsx -Value 'app.version + "|" + (typeof __JM_ARGS)' -Encoding ASCII
$ai.DoJavaScriptFile($jsx)
```
Expected: something like `30.0|undefined`. If it throws `0x8002801D` (type library not registered) or `0x80010001`/`0x8001010A` (busy), note which line failed and wait ~10 s after starting Illustrator, then retry.

## 4. The full adapter probe (needs the built app or the repo)
```
$env:JSON_MACLANE_PROBE = '1'; node dunk\src\server-cli.js
```
(or tray menu "Diagnosztika / Diagnostics"). Send the `probe-<timestamp>.txt` from the logs folder. Every step prints `[ OK ]` or `[FAIL]` with the error code and stderr.

## 5. Also try once
- Run the probe with Illustrator started as administrator (expect a clear access-denied message).
- Run it with a modal dialog open in Illustrator (expect `ILLUSTRATOR_BUSY` after about 15 s).
- A Windows user name with an accent.
