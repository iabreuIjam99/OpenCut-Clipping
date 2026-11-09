# Fixtures de extracción de audio

## `clip-5s.mp4` (24 535 B < 100 KB)

Vídeo de 5 s, 160×120, 5 fps, pista AAC mono (440 Hz), marca `isom`,
`moov` al principio (`+faststart`), para que el guard de Task 9 lea
`durationMs = 5000` sin recorrer el `mdat`.

Se generó **una sola vez** con el binario `ffmpeg-static` pinneado en el spike
de Task 6 (nunca con un ffmpeg del sistema ni descargado). Comando exacto,
ejecutado desde `apps/web`:

```powershell
D:\PROYECT\MonetizaClip\spikes\workerfs\node_modules\ffmpeg-static\ffmpeg.exe -y -hide_banner -nostdin -f lavfi -i color=c=black:s=160x120:r=5 -f lavfi -i sine=frequency=440 -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 1 -b:a 32k -movflags +faststart "src\lib\media\__fixtures__\clip-5s.mp4"
```

Se commitea porque es la única forma de ejercitar `extractAudio` de punta a
punta contra un contenedor real (el runtime de ffmpeg se inyecta falso en
tests: jsdom no ejecuta WASM).
