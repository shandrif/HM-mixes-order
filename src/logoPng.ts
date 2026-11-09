// Browser-only: render the brand logo to PNG for embedding in Excel files.
/** Render /logo.svg to a PNG (base64) in the browser so it can be embedded in the workbook. */
export async function logoPngBase64(src = "/logo.svg", size = 128): Promise<string | undefined> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d")!.drawImage(img, 0, 0, size, size);
    return canvas.toDataURL("image/png").split(",")[1];
  } catch {
    return undefined;
  }
}

