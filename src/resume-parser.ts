import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";

GlobalWorkerOptions.workerSrc = workerUrl;
export async function extractResume(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let text = "";
  if (file.name.toLowerCase().endsWith(".docx")) {
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    if (result.messages.some((m) => m.type === "error"))
      throw new Error("DOCX 部分内容未能读取，请检查文件后重试。");
    text = result.value;
  } else {
    const loading = getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      cMapUrl: "/cmaps/",
      cMapPacked: true,
    });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 100)
        throw new Error("PDF 超过 100 页，请选择简历文件。");
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        let lastY: number | undefined;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const value = item;
          const y = value.transform[5];
          if (
            lastY !== undefined &&
            Math.abs(y - lastY) > 2 &&
            !text.endsWith("\n")
          )
            text += "\n";
          text += value.str + (value.hasEOL ? "\n" : " ");
          lastY = y;
        }
        text += "\n\n";
        if (text.length > 1_000_000)
          throw new Error("提取文字超过 1 MB，请精简文件。");
        page.cleanup();
      }
    } finally {
      await loading.destroy();
    }
  }
  if (!text.trim())
    throw new Error(
      "未提取到文字。扫描件不提供 OCR，请改用文字版 PDF / DOCX，或手动录入档案。",
    );
  if (text.length > 1_000_000)
    throw new Error("提取文字超过 1 MB，请精简文件。");
  return text.trim();
}
