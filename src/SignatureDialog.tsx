import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "./pdf";
import type { PageViewport } from "pdfjs-dist";
import { Modal } from "./Dialogs";
import { keys } from "./platform";
import { Icon } from "./icons";
import { cleanSignature, fitSignature, readSignature, type SignatureImage, type SignatureTarget } from "./signatures";

export function SignatureDialog({ pdf, pageNumber, targets, onApprove, onClose }: {
  pdf: PDFDocumentProxy; pageNumber: number; targets: SignatureTarget[];
  onApprove: (signature: SignatureImage, rect: number[]) => Promise<void>; onClose: () => void;
}) {
  const [signature, setSignature] = useState<SignatureImage | null>(readSignature);
  const [saved, setSaved] = useState(() => !!readSignature());
  const [remember, setRemember] = useState(false);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [crop, setCrop] = useState<number[] | null>(null);
  const [threshold, setThreshold] = useState(180);
  const [camera, setCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState(targets[0]?.id || "manual");
  const [manualRect, setManualRect] = useState<number[] | null>(null);
  const [size, setSize] = useState(150);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; viewport: PageViewport } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cropCanvas = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureGeneration = useRef(0);
  const mounted = useRef(true);
  const dragStart = useRef<number[] | null>(null);
  const selected = targets.find(target => target.id === targetId);
  const bounds = selected?.rect || manualRect;
  const rect = signature && bounds ? fitSignature(signature, bounds) : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; captureGeneration.current++; streamRef.current?.getTracks().forEach(track => track.stop()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let render: { cancel: () => void } | undefined;
    void (async () => {
      const page = await pdf.getPage(pageNumber);
      const native = page.getViewport({ scale: 1, rotation: 0 });
      const viewport = page.getViewport({ scale: Math.min(480 / native.width, 580 / native.height), rotation: 0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      if (cancelled) return;
      const task = page.render({ canvas, viewport }); render = task;
      await task.promise;
      if (!cancelled) setPreview({ url: canvas.toDataURL(), width: viewport.width, height: viewport.height, viewport });
    })().catch(reason => { if (!cancelled) setError("Couldn't preview this page: " + String(reason)); });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, pageNumber]);

  useEffect(() => {
    if (camera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => setError("Camera preview couldn't start. Try uploading a photo instead."));
    }
  }, [camera]);

  useEffect(() => {
    if (!source || !cropCanvas.current) return;
    const canvas = cropCanvas.current;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(source, 0, 0);
    if (crop) { context.strokeStyle = "#2f6fed"; context.lineWidth = Math.max(2, source.width / 250); context.strokeRect(crop[0], crop[1], crop[2], crop[3]); }
  }, [source, crop]);

  useEffect(() => {
    if (!source || !crop) return;
    const timer = setTimeout(() => {
      try { setSignature(cleanSignature(source, crop, threshold)); setError(""); }
      catch (reason) { setSignature(null); setError((reason as Error).message); }
    }, 80);
    return () => clearTimeout(timer);
  }, [source, crop, threshold]);

  const stopCamera = () => {
    captureGeneration.current++;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    setCamera(false); setCameraReady(false); setCameraStarting(false);
  };
  useEffect(() => {
    const onSwitch = () => { if (window.frameElement?.hasAttribute("inert")) stopCamera(); };
    window.addEventListener("folio:tab-visibility", onSwitch);
    return () => window.removeEventListener("folio:tab-visibility", onSwitch);
  }, []);
  const startCamera = async () => {
    const generation = ++captureGeneration.current;
    setCameraStarting(true);
    setError("");
    try {
      // Desktop camera permission belongs to the Folio window that asks for consent.
      const devices = window.folioDesktop ? window.parent.navigator.mediaDevices : navigator.mediaDevices;
      if (!devices?.getUserMedia) throw new Error("Camera isn't available. Upload a photo instead.");
      const stream = await devices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
      if (!mounted.current || generation !== captureGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = stream; setCamera(true);
    } catch (reason) { if (mounted.current && generation === captureGeneration.current) setError("Couldn't access the camera. Check your camera permissions or upload a photo. " + (reason as Error).message); }
    finally { if (mounted.current && generation === captureGeneration.current) setCameraStarting(false); }
  };
  const acceptSource = (image: CanvasImageSource, width: number, height: number) => {
    const factor = Math.min(1, 1600 / Math.max(width, height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(width * factor); canvas.height = Math.round(height * factor);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    setSource(canvas); setCrop([0, 0, canvas.width, canvas.height]); setRemember(false); setSaved(false); setSignature(null); setError("");
  };
  const capture = () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    acceptSource(video, video.videoWidth, video.videoHeight); stopCamera();
  };
  const upload = async (file?: File) => {
    if (!file) return;
    stopCamera();
    const generation = ++captureGeneration.current;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("Please use a photo smaller than 20 MB.");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
      const bitmap = await createImageBitmap(file);
      try { if (mounted.current && generation === captureGeneration.current) acceptSource(bitmap, bitmap.width, bitmap.height); }
      finally { bitmap.close(); }
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
  };
  const cropPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(event.currentTarget.width, (event.clientX - bounds.left) * event.currentTarget.width / bounds.width)),
      Math.max(0, Math.min(event.currentTarget.height, (event.clientY - bounds.top) * event.currentTarget.height / bounds.height))];
  };
  const approve = async () => {
    if (!signature || !rect || !preview || busy || source || camera || cameraStarting) return;
    setBusy(true); setError("");
    try {
      await onApprove(signature, rect);
      if (remember) {
        try { localStorage.setItem("folio:signature", JSON.stringify(signature)); }
        catch { setError("Signature added, but couldn't remember it on this device. Close to continue."); setBusy(false); return; }
      }
      onClose();
    } catch (reason) { setError((reason as Error).message); setBusy(false); }
  };
  const screenRect = preview && rect ? [...preview.viewport.convertToViewportPoint(rect[0], rect[1]), ...preview.viewport.convertToViewportPoint(rect[2], rect[3])] : null;

  const ready = !!signature && !source && !camera && !cameraStarting;
  const placeAt = (pointX: number, pointY: number, width = size) => {
    if (!signature || !preview) return;
    const [left, bottom, right, top] = preview.viewport.viewBox;
    width = Math.min(width, right - left, (top - bottom) * signature.width / signature.height);
    const height = width * signature.height / signature.width;
    const positionX = Math.max(left, Math.min(right - width, pointX - width / 2));
    const positionY = Math.max(bottom, Math.min(top - height, pointY - height / 2));
    setManualRect([positionX, positionY, positionX + width, positionY + height]);
  };

  return <Modal title={"Sign page " + pageNumber} onClose={() => { if (!busy) onClose(); }}>
    <div className="signature-dialog">
      <div className="signature-intro">
        <p>Add your handwritten signature. Review the placement before adding it.</p>
        <ol className="signature-steps" aria-label="Signing progress">
          <li aria-current={!ready ? "step" : undefined} data-complete={ready || undefined}><span>{ready ? <Icon name="check" size={12} /> : "1"}</span> Add signature</li>
          <li aria-current={ready ? "step" : undefined}><span>2</span> Place on page</li>
        </ol>
      </div>
      <div className="signature-workspace-scroll"><fieldset disabled={busy} className="signature-workspace">
        <section className="signature-editor" aria-label="Signature capture">
          <div className="signature-section-head"><h3>Your signature</h3>{saved && ready && <span className="signature-badge">Saved on this device</span>}</div>
          {!signature && !source && !camera && <div className="signature-empty">
            <div className="signature-paper"><Icon name="signature" size={76} /></div>
            <h4>Start with pen and paper</h4><p>Sign white paper with dark ink, then capture or upload a photo.</p>
          </div>}
          {!source && !camera && <div className="signature-source-actions" data-compact={ready || undefined}>
            <button className="signature-source" disabled={cameraStarting} onClick={() => void startCamera()}><span className="signature-source-icon"><Icon name="camera" size={21} /></span><span><strong>{cameraStarting ? "Opening camera..." : "Use camera"}</strong><small>Capture from paper</small></span><Icon name="chevronRight" size={15} /></button>
            <button className="signature-source" onClick={() => uploadRef.current?.click()}><span className="signature-source-icon"><Icon name="upload" size={21} /></span><span><strong>Upload photo</strong><small>PNG, JPG or WebP</small></span><Icon name="chevronRight" size={15} /></button>
          </div>}
          <input ref={uploadRef} className="signature-upload" aria-label="Upload signature photo" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
          {camera && <div className="signature-camera">
            <div className="signature-camera-frame"><video ref={videoRef} muted playsInline onLoadedData={() => setCameraReady(true)} /><span className="signature-camera-guide" aria-hidden="true" /></div>
            <p className="signature-hint">Keep the paper flat and your signature inside the frame.</p>
            <div className="form-actions"><button className="btn ghost" onClick={stopCamera}>Stop camera</button><button className="btn primary" disabled={!cameraReady} onClick={capture}><Icon name="camera" size={15} /> Capture paper</button></div>
          </div>}
          {source && <div className="signature-crop">
            <p className="signature-hint">Drag a box around the signature to remove paper edges and shadows.</p>
            <div className="signature-photo"><canvas ref={cropCanvas} aria-label="Crop signature photo" onPointerDown={event => { if (event.button !== 0) return; dragStart.current = cropPoint(event); event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={event => { if (!dragStart.current) return; const point = cropPoint(event); setCrop([Math.min(point[0], dragStart.current[0]), Math.min(point[1], dragStart.current[1]), Math.max(1, Math.abs(point[0] - dragStart.current[0])), Math.max(1, Math.abs(point[1] - dragStart.current[1]))]); }}
              onPointerUp={() => { dragStart.current = null; }} onPointerCancel={() => { dragStart.current = null; }} /></div>
            <label className="signature-range">Ink sensitivity <input aria-label="Ink sensitivity" type="range" min="70" max="245" value={threshold} onChange={event => setThreshold(+event.target.value)} /></label>
            <button className="btn primary signature-use" disabled={!signature} onClick={() => {
              try { setSignature(cleanSignature(source, crop!, threshold)); setSource(null); setError(""); }
              catch (reason) { setError((reason as Error).message); }
            }}>Use this signature <Icon name="chevronRight" size={15} /></button>
            <button className="btn ghost" onClick={() => { setSource(null); setSignature(null); setError(""); }}>Choose another photo</button>
          </div>}
          {signature && !camera && <div className="signature-image"><img src={signature.url} alt="Your signature preview" /><span><Icon name="check" size={13} /> Background removed</span></div>}
          {ready && <label className="signature-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /><span>Remember this signature<small>Only on this device. Forget it in Settings.</small></span></label>}
          <div className="signature-privacy"><Icon name="lock" size={14} /><span>Processed on this device. Never uploaded.</span></div>
          <details className="signature-details"><summary>About signatures and saved copies</summary><p>This adds a visual signature, not a digital certificate. Changes can affect existing digital signatures. Remembered signatures are stored unencrypted on this computer. Use {keys("Ctrl+Z")} to undo; Save copy exports the signed PDF.</p></details>
        </section>
        <section className="signature-document" aria-label="Signature placement preview">
          <div className="signature-section-head"><h3>Page {pageNumber}</h3><span className="signature-badge">{selected ? "Suggested position" : "Page preview"}</span></div>
          {ready && <div className="signature-placement-controls">
            <label className="signature-field">Placement<select aria-label="Signature placement" value={targetId} onChange={event => setTargetId(event.target.value)}>{targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}<option value="manual">Choose a position on this page</option></select></label>
            {targetId === "manual" && <label className="signature-range">Signature width <input aria-label="Signature width" type="range" min="40" max="300" value={size} onChange={event => {
              const width = +event.target.value;
              setSize(width);
              if (manualRect) placeAt((manualRect[0] + manualRect[2]) / 2, (manualRect[1] + manualRect[3]) / 2, width);
            }} /></label>}
          </div>}
          <div className="signature-page-stage">
            {preview ? <div className="signature-page" data-placeable={ready && targetId === "manual" || undefined} style={{ width: Math.min(280, preview.width), aspectRatio: preview.width / preview.height }}
              role={ready && targetId === "manual" ? "button" : undefined} tabIndex={ready && targetId === "manual" ? 0 : undefined} aria-label={ready && targetId === "manual" ? "Place signature on page " + pageNumber : undefined} aria-describedby="signature-placement-hint"
              onClick={event => {
                if (!ready || targetId !== "manual") return;
                const area = event.currentTarget.getBoundingClientRect();
                const [pointX, pointY] = preview.viewport.convertToPdfPoint((event.clientX - area.left) * preview.width / area.width, (event.clientY - area.top) * preview.height / area.height);
                placeAt(pointX, pointY);
              }} onKeyDown={event => {
                if (!ready || targetId !== "manual" || !["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                const area = manualRect || preview.viewport.viewBox;
                placeAt((area[0] + area[2]) / 2 + (event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0), (area[1] + area[3]) / 2 + (event.key === "ArrowDown" ? -5 : event.key === "ArrowUp" ? 5 : 0));
              }}><img className="signature-page-background" src={preview.url} alt={"Page " + pageNumber + " placement preview"} />
                {signature && screenRect && <img className="signature-placement" src={signature.url} alt="Proposed signature location" style={{ left: Math.min(screenRect[0], screenRect[2]) / preview.width * 100 + "%", top: Math.min(screenRect[1], screenRect[3]) / preview.height * 100 + "%", width: Math.abs(screenRect[2] - screenRect[0]) / preview.width * 100 + "%", height: Math.abs(screenRect[3] - screenRect[1]) / preview.height * 100 + "%" }} />}
              </div> : <div className="signature-page-loading" role="status"><Icon name="file" size={30} /><span>Loading page preview...</span></div>}
          </div>
          <p className="signature-hint" id="signature-placement-hint" aria-live="polite">{!ready ? "Your signature will appear here for review." : selected ? "Signature field or line detected. Check the suggested position." : manualRect ? "Click to reposition, or use the arrow keys to fine-tune." : "Click the page to place your signature, or focus it and press Enter."}</p>
        </section>
      </fieldset></div>
      {error && <p className="form-error signature-error" role="alert">{error}</p>}
      <div className="signature-footer"><span>Nothing is added until you approve.</span><div className="form-actions"><button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ready || !rect || !preview || busy} onClick={() => void approve()}><Icon name="check" size={15} />{busy ? "Adding signature..." : "Approve and add signature"}</button></div></div>
    </div>
  </Modal>;
}
