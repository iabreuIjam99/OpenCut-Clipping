# Genera el corpus de audio del spike con la voz SAPI "Microsoft Zira Desktop" (R4).
# - fixtures/long-10min.wav  : el texto completo leído de una vez (540-660 s validados con ffmpeg-static)
# - fixtures/sentence-01..20.wav : las 20 primeras frases de script.txt, una por fichero
# - fixtures/sentences.json  : referencias exactas (versionado) + duración medida por frase
# Nada de esto se descarga: el texto está en fixtures/script.txt (original, CC0).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$root     = Split-Path -Parent $PSScriptRoot
$fixtures = Join-Path $root 'fixtures'
$scriptTxt = Join-Path $fixtures 'script.txt'
$ffmpeg   = Join-Path $root 'node_modules\ffmpeg-static\ffmpeg.exe'

if (-not (Test-Path $scriptTxt)) { throw "No existe $scriptTxt" }
if (-not (Test-Path $ffmpeg))    { throw "No existe $ffmpeg (ejecuta antes: bun install)" }

$voice = 'Microsoft Zira Desktop'

# Duración real de un WAV, medida con el binario de ffmpeg-static (R4).
# Nota: ffmpeg escribe en stderr aunque vaya bien; con $ErrorActionPreference
# 'Stop' ese stderr se convertiría en NativeCommandError y abortaría el
# script, así que en el ámbito de la función se relaja a 'Continue'.
function Get-WavDurationMs([string]$path) {
  $ErrorActionPreference = 'Continue'
  $out = (& $ffmpeg -hide_banner -nostdin -i $path 2>&1 | Out-String)
  if ($out -match 'Duration:\s*(\d+):(\d+):(\d+\.\d+)') {
    $h = [int]$Matches[1]; $m = [int]$Matches[2]; $s = [double]$Matches[3]
    return [int][math]::Round(($h * 3600 + $m * 60 + $s) * 1000)
  }
  throw "ffmpeg no informó de duración para $path"
}

$sentences = @(Get-Content -LiteralPath $scriptTxt -Encoding UTF8 | ForEach-Object { [string]$_ } | Where-Object { $_ -match '\S' })
if ($sentences.Count -lt 20) { throw "script.txt tiene menos de 20 frases" }
$fullText = ($sentences -join ' ')
$wordCount = ($fullText -split '\s+').Count
Write-Output "script.txt: $($sentences.Count) frases, $wordCount palabras"

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
if ($installed -notcontains $voice) {
  throw "Voz '$voice' no instalada. Voces disponibles: $($installed -join ', ')"
}
$synth.SelectVoice($voice)
$synth.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)

# --- 1) 20 frases individuales (las 20 primeras líneas de script.txt) -------
$sentJson = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt 20; $i++) {
  $n    = '{0:d2}' -f ($i + 1)
  $text = $sentences[$i]
  $path = Join-Path $fixtures ("sentence-$n.wav")
  $synth.SetOutputToWaveFile($path, $fmt)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  $dur = Get-WavDurationMs $path
  $sentJson.Add([ordered]@{
    index      = $i + 1
    file       = "sentence-$n.wav"
    text       = $text
    durationMs = $dur
  })
  Write-Output ("sentence-{0}.wav = {1} ms" -f $n, $dur)
}

# sentences.json SIN BOM (JSON.parse del navegador rechaza el BOM).
$sentencesJsonPath = Join-Path $fixtures 'sentences.json'
$json = ($sentJson | ConvertTo-Json -Depth 4)
[System.IO.File]::WriteAllText($sentencesJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "escrito: $sentencesJsonPath"

# --- 2) Long-form completo (540-660 s) ajustando Rate -----------------------
$longPath = Join-Path $fixtures 'long-10min.wav'
$rate = 0
$dur = 0
$ok = $false
for ($try = 0; $try -lt 8; $try++) {
  $synth.Rate = $rate
  $synth.SetOutputToWaveFile($longPath, $fmt)
  $synth.Speak($fullText)
  $synth.SetOutputToNull()
  $dur = Get-WavDurationMs $longPath
  Write-Output ("long-10min.wav: rate={0} duración={1} ms" -f $rate, $dur)
  if ($dur -ge 540000 -and $dur -le 660000) { $ok = $true; break }
  if ($dur -gt 660000) { $rate++ } else { $rate-- }
  if ($rate -gt 10 -or $rate -lt -10) { throw "Rate fuera del rango de SAPI (±10) intentándolo con $rate" }
}
if (-not $ok) { throw "long-10min.wav quedó en $dur ms, fuera de 540000-660000" }

$longBytes = (Get-Item -LiteralPath $longPath).Length
$synth.Dispose()

$bytesPerSecond = 16000 * 2  # 16 kHz mono PCM 16 bits
$expectedBytes = [int]($dur / 1000 * $bytesPerSecond)
Write-Output ("RESUMEN: long-10min.wav = {0} ms ({1} s), rate={2}, {3} B, esperado≈{4} B, palabras={5}" -f `
  $dur, [math]::Round($dur / 1000, 1), $rate, $longBytes, $expectedBytes, $wordCount)
if ([math]::Abs($longBytes - $expectedBytes) -gt 44) {
  Write-Output "AVISO: el tamaño del WAV no cuadra con la duración declarada (¿formato distinto de PCM?)"
}
