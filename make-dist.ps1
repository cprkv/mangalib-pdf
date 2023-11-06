go build -o installer/mangalib-pdf.exe -ldflags "-s -w"
if (!$?) { return }

Set-Location installer
Remove-Item -r Output -ErrorAction SilentlyContinue
."C:\Program Files (x86)\Inno Setup 6\iscc.exe" .\main.iss
Set-Location ..

echo "DONE!"