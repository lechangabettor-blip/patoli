# Local stand-in for the Vercel crons while the app runs on this PC.
# Every 60s: settle/sweep Arena matches, and (every 5th tick) run the bets indexer.
$envFile = Join-Path $PSScriptRoot "..\.env.local"
$secret = (Get-Content $envFile | Where-Object { $_ -match '^INDEXER_SECRET=' }) -replace '^INDEXER_SECRET=', ''
$secret = $secret.Trim('"')
$i = 0
while ($true) {
  $i++
  try {
    $r = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/arena/settle" -Headers @{ "x-indexer-secret" = $secret } -TimeoutSec 170
    $s = $r.settled
    if ($s.sent -gt 0 -or $r.ticked -gt 0) { Write-Host ("{0} arena: ticked={1} settled={2} tx={3}" -f (Get-Date -Format "HH:mm:ss"), $r.ticked, $s.sent, $s.tx) }
  } catch { Write-Host ("{0} arena settle failed: {1}" -f (Get-Date -Format "HH:mm:ss"), $_.Exception.Message) }
  if ($i % 5 -eq 0) {
    try {
      $x = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/indexer/run" -Headers @{ "x-indexer-secret" = $secret } -TimeoutSec 170
      if ($x.settled -gt 0 -or $x.betsUpserted -gt 0) { Write-Host ("{0} indexer: trades={1} settled={2}" -f (Get-Date -Format "HH:mm:ss"), $x.tradesSeen, $x.settled) }
    } catch { Write-Host ("{0} indexer failed: {1}" -f (Get-Date -Format "HH:mm:ss"), $_.Exception.Message) }
  }
  Start-Sleep -Seconds 60
}
