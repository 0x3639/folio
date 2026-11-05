import type { ReviewStyle } from './reviewModel';

interface Props {
  style: ReviewStyle;
  onChange: (patch: Partial<ReviewStyle>) => void;
  disabled: boolean;
}
export function ReviewStylePanel({ style, onChange, disabled }: Props) {
  return <section className="review-style" aria-label="Markup style">
    <div className="review-style-preview" aria-label="Style preview">
      <svg viewBox="0 0 280 92" role="img" aria-label="Preview of color, fill, line and text appearance">
        <g opacity={style.opacity}>
          <rect x="10" y="10" width="260" height="72" rx="3" fill={style.fill} stroke={style.color} strokeWidth={Math.min(style.width, 12)} strokeDasharray={style.dash === 'dashed' ? '8 4' : style.dash === 'dotted' ? '2 4' : undefined} />
          <text x="140" y="52" textAnchor="middle" fill={style.color} fontFamily={style.font === 'serif' ? 'serif' : style.font === 'mono' ? 'monospace' : 'sans-serif'} fontSize={Math.min(style.fontSize, 40)}>Markup</text>
        </g>
      </svg>
      <small>Appearance preview</small>
    </div>
    <fieldset disabled={disabled}>
      <legend>Color and fill</legend>
      <label className="review-color-field">Line and text color <input aria-label="Stroke" type="color" value={style.color} onChange={e => onChange({ color: e.target.value })} /><code>{style.color.toUpperCase()}</code></label>
      <div className="review-color-swatches" aria-label="Common colors">{['#e5533d', '#2f6fed', '#1f9d55', '#f0a020', '#8b5cf6', '#333333'].map(color => <button key={color} type="button" aria-label={`Use color ${color}`} aria-pressed={style.color.toLowerCase() === color} style={{ backgroundColor: color }} onClick={() => onChange({ color })} />)}</div>
      <label><input type="checkbox" checked={style.fill !== 'none'} onChange={e => onChange({ fill: e.target.checked ? '#fff4b8' : 'none' })} /> Use fill</label>
      {style.fill !== 'none' && <label className="review-color-field">Fill color <input aria-label="Fill" type="color" value={style.fill} onChange={e => onChange({ fill: e.target.value })} /><code>{style.fill.toUpperCase()}</code></label>}
      <label>Opacity · {Math.round(style.opacity * 100)}% <input aria-label="Opacity" type="range" min="0.05" max="1" step="0.05" value={style.opacity} onChange={e => onChange({ opacity: Number(e.target.value) })} /></label>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Line</legend>
      <div className="review-fields"><label>Weight (pt) <input aria-label="Line weight" type="number" min="0.1" max="20" step="0.5" value={style.width} onChange={e => { const width = Number(e.target.value); if (width >= .1 && width <= 20) onChange({ width }); }} /></label><label>Pattern <select aria-label="Line style" value={style.dash} onChange={e => onChange({ dash: e.target.value as ReviewStyle['dash'] })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label></div>
      <label><input type="checkbox" checked={style.arrow} onChange={e => onChange({ arrow: e.target.checked })} /> Arrowhead on lines and callouts</label>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Text</legend>
      <div className="review-fields"><label>Font <select aria-label="Font" value={style.font} onChange={e => onChange({ font: e.target.value as ReviewStyle['font'] })}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label><label>Size (pt) <input aria-label="Text size" type="number" min="6" max="96" value={style.fontSize} onChange={e => { const fontSize = Number(e.target.value); if (fontSize >= 6 && fontSize <= 96) onChange({ fontSize }); }} /></label></div>
      <p className="review-hint">Font and size apply to text boxes, callouts, and stamps.</p>
    </fieldset>
  </section>;
}
