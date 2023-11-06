package main

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/storage"
	"fyne.io/fyne/v2/widget"
	"github.com/PuerkitoBio/goquery"
	"github.com/dop251/goja"
	"github.com/signintech/gopdf"
	"golang.org/x/net/html"
)

func cacheDir() string {
	path := checkRet(os.UserCacheDir())
	dir := filepath.Join(path, "mangalib", "cache")
	check(os.MkdirAll(dir, os.ModePerm))
	return dir
}

func tmpDir() string {
	path := checkRet(os.UserCacheDir())
	dir := filepath.Join(path, "mangalib", "tmp")
	check(os.MkdirAll(dir, os.ModePerm))
	return dir
}

func check(e error) {
	if e != nil {
		panic(e)
	}
}

func checkRet[R any](res R, err error) R {
	check(err)
	return res
}

func md5Hash(text string) string {
	hasher := md5.New()
	hasher.Write([]byte(text))
	return hex.EncodeToString(hasher.Sum(nil))
}

func fileExists(filepath string) bool {
	_, err := os.Stat(filepath)
	return !errors.Is(err, os.ErrNotExist)
}

func runImageMagick(commandArgs ...string) bool {
	_, ok := runImageMagickOutput(commandArgs...)
	return ok
}

func runImageMagickOutput(commandArgs ...string) (string, bool) {
	output, err := exec.Command("./image-magic/magick.exe", commandArgs...).Output()
	if err != nil {
		switch e := err.(type) {
		case *exec.Error:
			panic(err)
		case *exec.ExitError:
			fmt.Println("bad command exit code", e.ExitCode())
			return "", false
		default:
			panic(err)
		}
	}
	return string(output), true
}

func httpGetImage(url string, filepath string) (err error) {
	finishMarker := filepath + ".done"
	if fileExists(finishMarker) && fileExists(filepath) {
		fmt.Printf("%s already downloaded: %s\n", url, filepath)
		return nil
	}

	fmt.Printf("downloading %s -> %s\n", url, filepath)
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bad status: %s", resp.Status)
	}

	out, err := os.Create(filepath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		defer os.Remove(filepath)
		return err
	}

	if !runImageMagick("identify", filepath) {
		return fmt.Errorf("bad image")
	} else {
		fmt.Printf("check image %s ok!\n", filepath)
	}

	return os.WriteFile(finishMarker, []byte{0xDE, 0xAD, 0xBE, 0xEF}, os.ModeType)
}

func httpGetCached(url string) (string, error) {
	hash := md5Hash(url)
	cacheFile := filepath.Join(cacheDir(), hash)

	data, err := os.ReadFile(cacheFile)

	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}

		fmt.Printf("cache not found for %s, downloading...\n", url)
		res, err := http.Get(url)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()

		if res.StatusCode != http.StatusOK {
			return "", fmt.Errorf("status code error: %d %s", res.StatusCode, res.Status)
		}

		data, err = io.ReadAll(res.Body)
		if err != nil {
			return "", err
		}
		if err = os.WriteFile(cacheFile, data, os.ModeType); err != nil {
			return "", err
		}
	} else {
		fmt.Printf("using cache (%s) for %s\n", cacheFile, url)
	}

	return string(data), nil
}

type ChapterShortInfo struct {
	Name   string
	Index  string
	Volume string
}

type ChapterShortInfoList []ChapterShortInfo

func (c ChapterShortInfoList) Len() int      { return len(c) }
func (c ChapterShortInfoList) Swap(i, j int) { c[i], c[j] = c[j], c[i] }
func (c ChapterShortInfoList) Less(i, j int) bool {
	a := checkRet(strconv.ParseFloat(c[i].Index, 32))
	b := checkRet(strconv.ParseFloat(c[j].Index, 32))
	return a < b
}

type MangaInfo struct {
	Name             string
	Slug             string
	Cover            *ImageInfo
	ChaptersByVolume map[string][]ChapterShortInfo
}

type PageInfo struct {
	Index int
	Urls  []string
}

type ChapterInfo []PageInfo

func parseHtml(htmlString string) (*goquery.Document, error) {
	node, err := html.Parse(strings.NewReader(htmlString))
	if err != nil {
		return nil, err
	}
	return goquery.NewDocumentFromNode(node), nil
}

func runHtmlScriptsInVM(htmlString string, jsonReturn string) (string, error) {
	doc, err := parseHtml(htmlString)
	if err != nil {
		return "", err
	}
	return runHtmlScriptsInVMHTML(doc, jsonReturn)
}

func runHtmlScriptsInVMHTML(doc *goquery.Document, jsonReturn string) (string, error) {
	vm := goja.New()
	_, err := vm.RunString(`var window = {};`)
	if err != nil {
		return "", err
	}

	doc.Find("script").Each(func(i int, s *goquery.Selection) {
		script := s.Text()
		if strings.Contains(script, "window.__DATA__") ||
			strings.Contains(script, "window.__pg") {
			_, err = vm.RunString(script)
			if err != nil {
				fmt.Printf("error running vm script: %v\n", err)
			}
		}
	})

	jsString := fmt.Sprintf("JSON.stringify(%s, null, 2)", jsonReturn)
	// fmt.Printf("running %s\n", jsString)
	value, err := vm.RunString(jsString)
	if err != nil {
		return "", err
	}
	return value.Export().(string), nil
}

func downloadSingleImage(url string, output string) (*ImageInfo, error) {
	ext := filepath.Ext(url)
	tmpFile := output + ext
	err := httpGetImage(url, tmpFile)
	if err != nil {
		return nil, err
	}
	return convertToJpegSingle(tmpFile)
}

func parseMangaInfo(mangaHtmlString string) (*MangaInfo, error) {
	doc, err := parseHtml(mangaHtmlString)
	if err != nil {
		return nil, err
	}
	mangaInfoStr, err := runHtmlScriptsInVMHTML(doc, `{
		name: window.__DATA__.manga.rusName || window.__DATA__.manga.engName || window.__DATA__.manga.slug,
		slug: window.__DATA__.manga.slug,
		chaptersByVolume: window.__DATA__.chapters.list.reduce((rv, x) => {
			(rv[x.chapter_volume] = rv[x.chapter_volume] || []).push({
				name: x.chapter_name,
				index: x.chapter_number,
				volume: x.chapter_volume.toString(),
			});
			return rv;
		}, {}),
	}`)
	if err != nil {
		return nil, err
	}

	// fmt.Printf("mangaInfo: %s\n", mangaInfoStr)
	var mangaInfo MangaInfo
	err = json.Unmarshal([]byte(mangaInfoStr), &mangaInfo)
	if err != nil {
		return nil, err
	}
	mangaInfo.Cover = nil

	img := doc.Find(".media-sidebar__cover img").First()
	if imgSrc, exists := img.Attr("src"); exists {
		fmt.Printf("cover image: %s\n", imgSrc)
		outFile := filepath.Join(tmpDir(), mangaInfo.Slug+"_cover")
		cover, err := downloadSingleImage(imgSrc, outFile)
		if err == nil {
			mangaInfo.Cover = cover
		} else {
			fmt.Printf("error loading cover image: %v\n", err)
		}
	} else {
		fmt.Printf("cover image not found!\n")
	}

	return &mangaInfo, nil
}

func parseChapterInfo(chapterHtmlString string) (ChapterInfo, error) {
	chapterInfoStr, err := runHtmlScriptsInVM(chapterHtmlString, `window.__pg.map(pg => ({
		index: pg.p,
		urls: Object.values(window.__info.servers).map(srv => srv + window.__info.img.url + pg.u)
	}))`)
	if err != nil {
		return nil, err
	}
	// fmt.Printf("chapter info: %s\n", chapterInfoStr)
	var chapterInfo ChapterInfo
	err = json.Unmarshal([]byte(chapterInfoStr), &chapterInfo)
	if err != nil {
		return nil, err
	}
	return chapterInfo, nil
}

type ImageInfo struct {
	Path   string
	Width  int
	Height int
}

func downloadChapter(slug string, chapterInfo ChapterInfo) []string {
	fmt.Printf("downloading chapter: %s\n", slug)

	outDir := filepath.Join(tmpDir(), slug)
	check(os.MkdirAll(outDir, os.ModePerm))
	resultImages := []string{}

	for _, page := range chapterInfo {
		downloadOk := false
		for _, url := range page.Urls {
			ext := filepath.Ext(url)
			outFile := filepath.Join(outDir, strconv.Itoa(page.Index)+ext)
			err := httpGetImage(url, outFile)
			if err == nil {
				resultImages = append(resultImages, outFile)
				downloadOk = true
				break
			}
			fmt.Printf("error downloading image: %v\n", err)
		}
		if !downloadOk {
			panic("error downloading image")
		}
	}

	return resultImages
}

func convertToJpegSingle(path string) (*ImageInfo, error) {
	outPath := path + ".jpg"
	if !fileExists(outPath) || !runImageMagick("identify", outPath) {
		fmt.Printf("converting image %s to jpeg\n", path)
		if !runImageMagick(path+"[0]", "-quality", "75", outPath) {
			return nil, fmt.Errorf("error converting image %s", path)
		}
		fmt.Printf("output image: %s\n", outPath)
	}
	dims, ok := runImageMagickOutput("identify", "-format", "%wx%h", outPath)
	if !ok {
		return nil, fmt.Errorf("can't identify image dims: %s", outPath)
	}
	var width, height int
	numScan, err := fmt.Sscanf(dims, "%dx%d", &width, &height)
	if numScan != 2 || err != nil {
		return nil, fmt.Errorf("error parsing image dims: scanned: %d, error: %v", numScan, err)
	}
	return &ImageInfo{
		Path:   outPath,
		Width:  width,
		Height: height,
	}, nil
}

func convertToJpeg(inputImages []string) ([]ImageInfo, error) {
	type OutImageInfo struct {
		ImageInfo *ImageInfo
		Error     error
		Index     int
	}
	outputImagesChan := make(chan OutImageInfo)
	runConvert := func(path string, index int) {
		image, err := convertToJpegSingle(path)
		outputImagesChan <- OutImageInfo{
			ImageInfo: image,
			Error:     err,
			Index:     index,
		}
	}
	for index, imagePath := range inputImages {
		go runConvert(imagePath, index)
	}
	outputImages := []OutImageInfo{}
	for i := 0; i < len(inputImages); i++ {
		outputImages = append(outputImages, <-outputImagesChan)
	}
	sort.Slice(outputImages, func(i, j int) bool {
		return outputImages[i].Index < outputImages[j].Index
	})
	result := []ImageInfo{}
	for _, outputImage := range outputImages {
		if outputImage.Error != nil {
			return nil, outputImage.Error
		}
		result = append(result, *outputImage.ImageInfo)
	}
	return result, nil
}

const pdfMargin = 30

func pdfPrintText(pdf *gopdf.GoPdf, text string, position int, size int) int {
	check(pdf.SetFontSize(float64(size)))
	lineHeight := size
	for _, text := range checkRet(pdf.SplitTextWithWordWrap(text, gopdf.PageSizeA4.W-pdfMargin*2)) {
		pdf.SetXY(pdfMargin, float64(position+pdfMargin))
		check(pdf.Text(text))
		position += lineHeight
	}
	return position
}

func coverSize(imgW, imgH, w, h int) (float32, float32) {
	return coverSizeF(float32(imgW), float32(imgH), float32(w), float32(h))
}

func coverSizeF(imgW, imgH, w, h float32) (float32, float32) {
	rW := w / imgW
	rH := h / imgH
	coverRatio := rW
	if rH < rW {
		coverRatio = rH
	}
	return imgW * coverRatio, imgH * coverRatio
}

var globalWindow *fyne.Window = nil

func onError(err error) {
	if globalWindow != nil {
		dialog.ShowError(err, *globalWindow)
	} else {
		w := fyne.CurrentApp().NewWindow("Error")
		w.SetContent(container.NewVBox(
			widget.NewLabel(err.Error()),
			widget.NewButton("Ok", func() {
				w.Close()
			}),
		))
		w.Show()
	}
}

type MangaStatus struct {
	OutPath string
	Error   error
}

func getMangaPDF(
	mangaUrl string,
	chapterList ChapterShortInfoList,
	mangaInfo *MangaInfo,
	selectedVolume string,
	outPath string,
	getMangaStatus chan MangaStatus) {

	pdf := gopdf.GoPdf{}
	pdf.Start(gopdf.Config{PageSize: *gopdf.PageSizeA4})
	check(pdf.AddTTFFont("pt-root-ui", "./pt-root-ui_medium.ttf"))
	check(pdf.SetFont("pt-root-ui", "", 14))

	for chapterShortId := range chapterList {
		chapterShort := &chapterList[chapterShortId]
		chapterUrl := fmt.Sprintf("%s/v%s/c%s", mangaUrl, chapterShort.Volume, chapterShort.Index)

		chapterHtmlString, err := httpGetCached(chapterUrl)
		if err != nil {
			getMangaStatus <- MangaStatus{Error: err}
			return
		}

		chapterInfo, err := parseChapterInfo(chapterHtmlString)
		if err != nil {
			getMangaStatus <- MangaStatus{Error: err}
			return
		}

		chapterSlug := fmt.Sprintf("%s-v%s-c%s", mangaInfo.Slug, chapterShort.Volume, chapterShort.Index)
		inputImages := downloadChapter(chapterSlug, chapterInfo)
		outputImages, err := convertToJpeg(inputImages)
		if err != nil {
			getMangaStatus <- MangaStatus{Error: err}
			return
		}

		pdf.AddPage()
		position := pdfMargin
		if mangaInfo.Cover != nil {
			var width = mangaInfo.Cover.Width / 2
			var heigth = mangaInfo.Cover.Height / 2
			check(pdf.Image(mangaInfo.Cover.Path, pdfMargin, float64(position), &gopdf.Rect{
				W: float64(width),
				H: float64(heigth),
			}))
			position += heigth + 16
		}
		position = pdfPrintText(&pdf, mangaInfo.Name, position, 48)
		pdf.SetLineWidth(1)
		pdf.SetLineType("dashed")
		lineY := float64(position)
		pdf.Line(pdfMargin, lineY, gopdf.PageSizeA4.W-pdfMargin*2, lineY)
		position += 16
		position = pdfPrintText(&pdf, fmt.Sprintf("Том: %s", selectedVolume), position, 42)
		pdfPrintText(&pdf, fmt.Sprintf("Глава %s: %s", chapterShort.Index, chapterShort.Name), position, 42)

		for _, img := range outputImages {
			pdf.AddPage()
			fmt.Printf("adding image %s with size %dx%d\n", img.Path, img.Width, img.Height)
			smallMargin := 10
			w, h := coverSize(
				img.Width, img.Height,
				int(gopdf.PageSizeA4.W)-smallMargin*2,
				int(gopdf.PageSizeA4.H)-smallMargin*2,
			)
			// fmt.Printf("cover size: %fx%f\n", w, h)
			check(pdf.Image(
				img.Path,
				float64(smallMargin), float64(smallMargin),
				&gopdf.Rect{W: float64(w), H: float64(h)},
			))
		}
	}

	outFile := filepath.Join(outPath, fmt.Sprintf("%s-v%s.pdf", mangaInfo.Slug, selectedVolume))
	fmt.Printf("making pdf: %s\n", outFile)
	err := pdf.WritePdf(outFile)

	fmt.Printf("done!\n")
	getMangaStatus <- MangaStatus{OutPath: outFile, Error: err}
}

func main() {
	var mangaInfo *MangaInfo = nil
	var selectedVolume *string = nil
	_ = selectedVolume
	var vbox *fyne.Container
	var volumeBox *fyne.Container = container.NewVBox()

	a := app.NewWithID("net.ru.vy.mangalib-pdf")
	w := a.NewWindow("MangaLib to PDF converter")
	globalWindow = &w

	mangaUrlInput := widget.NewEntry()
	mangaUrlInput.SetPlaceHolder("https://mangalib.me/...")
	mangaUrlInput.SetText(a.Preferences().String("mangaUrlInput"))
	mangaUrlInput.OnChanged = func(input string) {
		a.Preferences().SetString("mangaUrlInput", input)
		volumeBox.RemoveAll()
	}

	onToPDF := func() {
		if selectedVolume == nil || mangaInfo == nil {
			onError(fmt.Errorf("no volume selected!"))
			return
		}
		chapterList, hasVolume := mangaInfo.ChaptersByVolume[*selectedVolume]
		if !hasVolume {
			onError(fmt.Errorf("bad volume selected. press \"Get volumes\""))
			return
		}

		openDirDialog := dialog.NewFolderOpen(func(uri fyne.ListableURI, err error) {
			if err != nil {
				fmt.Printf("error save file: %v\n", err)
				return
			}
			if uri == nil {
				fmt.Printf("directory not selected\n")
				return
			}

			a.Preferences().SetString("mangaOutDir", uri.Path())
			fmt.Printf("uri: %s\n", uri.Path())
			sort.Sort(ChapterShortInfoList(chapterList))

			getMangaStatus := make(chan MangaStatus)
			go getMangaPDF(mangaUrlInput.Text, chapterList, mangaInfo, *selectedVolume, uri.Path(), getMangaStatus)

			d := dialog.NewCustomWithoutButtons("Processing...", container.NewVBox(widget.NewLabel("Wait...")), *globalWindow)
			d.Show()

			go func() {
				status := <-getMangaStatus
				d.Hide()
				if status.Error != nil {
					onError(status.Error)
					return
				}
				var statusDialog *dialog.CustomDialog = nil
				statusDialog = dialog.NewCustom("Processing status", "Ok", widget.NewButton("Open in output directory", func() {
					statusDialog.Hide()
					cmd := exec.Command("explorer", "/select,", status.OutPath)
					var stdout bytes.Buffer
					var stderr bytes.Buffer
					cmd.Stdout = &stdout
					cmd.Stderr = &stderr
					err := cmd.Run()
					fmt.Printf("run explorer stdout: %s\n", stdout.String())
					fmt.Printf("run explorer stdout: %s\n", stderr.String())
					if err != nil {
						fmt.Println(err)
					}
				}), *globalWindow)
				statusDialog.Show()
			}()
		}, *globalWindow)

		if prevDir := a.Preferences().String("mangaOutDir"); len(prevDir) > 0 {
			if !strings.HasPrefix(prevDir, "file://") {
				prevDir = "file://" + prevDir
			}
			uri, err := storage.ParseURI(prevDir)
			if err == nil {
				lister, err := storage.ListerForURI(uri)
				if err == nil {
					openDirDialog.SetLocation(lister)
				} else {
					fmt.Printf("error creating lister for mangaOutDir: %v\n", err)
				}
			} else {
				fmt.Printf("error parsing mangaOutDir: %v\n", err)
			}
		} else {
			fmt.Printf("mangaOutDir not set\n")
		}

		openDirDialog.Show()
	}

	onGetVolumes := func() {
		volumeBox.RemoveAll()

		mangaHtmlString, err := httpGetCached(mangaUrlInput.Text)
		if err != nil {
			onError(err)
			return
		}

		mangaInfo, err = parseMangaInfo(mangaHtmlString)
		if err != nil {
			onError(err)
			return
		}

		volumeOptions := []string{}
		for volume, _ := range mangaInfo.ChaptersByVolume {
			volumeOptions = append(volumeOptions, volume)
		}
		sort.Slice(volumeOptions, func(i, j int) bool {
			a := checkRet(strconv.ParseFloat(volumeOptions[i], 64))
			b := checkRet(strconv.ParseFloat(volumeOptions[j], 64))
			return a < b
		})

		volumeBoxH := container.NewHBox()
		if mangaInfo.Cover != nil {
			image := canvas.NewImageFromFile(mangaInfo.Cover.Path)
			image.FillMode = canvas.ImageFillOriginal
			volumeBoxH.Add(image)
			image.Refresh()
		}
		volumeBoxSelector := container.NewVBox()
		volumeBoxSelector.Add(widget.NewLabel("Select volume:"))
		volumeBoxSelector.Add(widget.NewRadioGroup(volumeOptions, func(v string) {
			selectedVolume = &v
		}))
		volumeBoxH.Add(volumeBoxSelector)
		volumeBoxSelector.Refresh()
		volumeBox.Add(volumeBoxH)

		volumeBox.Add(widget.NewButton("To PDF", onToPDF))
	}

	vbox = container.NewVBox(
		widget.NewLabel("Manga URL:"),
		mangaUrlInput,
		widget.NewButton("Get volumes", onGetVolumes),
		layout.NewSpacer(),
		volumeBox,
	)
	w.SetContent(vbox)
	fmt.Printf("size: %fx%f\n", w.Content().Size().Width, w.Content().Size().Height)
	w.Resize(fyne.NewSize(640, 640))
	w.ShowAndRun()
}
