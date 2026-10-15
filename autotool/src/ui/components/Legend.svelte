<!-- Always visible. Every meaning has a shape or line pattern, not only a colour. -->
<div class="legend" aria-label="Route legend">
  <span><svg viewBox="0 0 30 10"><line x1="1" y1="5" x2="24" y2="5" stroke="var(--drive)" stroke-width="1.6" /><path d="M23 1.5 L29 5 L23 8.5z" fill="#fff" /></svg>Driving</span>
  <span><svg viewBox="0 0 30 10"><line x1="1" y1="5" x2="29" y2="5" stroke="var(--intake)" stroke-opacity="0.6" stroke-width="8" /><path d="M8 2 L12 5 L8 8 M18 2 L22 5 L18 8" stroke="#04220f" fill="none" stroke-width="1.4" /></svg>Intake on (IN; lime dashes = ramp out too)</span>
  <span><svg viewBox="0 0 30 10"><circle cx="15" cy="5" r="4" fill="none" stroke="var(--shoot)" stroke-width="1.3" /><circle cx="15" cy="5" r="1.6" fill="var(--shoot)" /></svg>Shoot (−N fired)</span>
  <span><svg viewBox="0 0 30 10"><circle cx="15" cy="5" r="4" fill="#111" stroke="#fff" stroke-width="1" /><path d="M15 5 V2.2 M15 5 H17.4" stroke="#fff" stroke-width="0.9" /></svg>Wait</span>
  <span><svg viewBox="0 0 30 10"><line x1="1" y1="5" x2="29" y2="5" stroke="var(--repo)" stroke-width="1.8" stroke-dasharray="4 2.5" /></svg>Go on (end NONE)</span>
  <span><svg viewBox="0 0 30 10"><rect x="10" y="0.5" width="9" height="9" fill="#fff" /><text x="14.5" y="7.6" font-size="8" font-weight="900" text-anchor="middle" fill="#000">P</text></svg>Park</span>
  <span><svg viewBox="0 0 30 10"><line x1="1" y1="5" x2="20" y2="5" stroke="var(--unsure)" stroke-width="1.8" stroke-dasharray="3 2" /><circle cx="25" cy="5" r="4" fill="var(--unsure)" /><text x="25" y="7.6" font-size="7" font-weight="900" text-anchor="middle" fill="#000">?</text></svg>Review</span>
  <span><svg viewBox="0 0 30 10"><rect x="1" y="1" width="28" height="8" fill="url(#lgHatch)" stroke="var(--nogo)" /><defs><pattern id="lgHatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="var(--nogo)" /></pattern></defs></svg>No-go</span>
  <span><svg viewBox="0 0 30 10"><circle cx="15" cy="5" r="3" fill="var(--pollen)" stroke="#000" /></svg>POLLEN</span>
  <span><svg viewBox="0 0 30 10"><rect x="2" y="2" width="12" height="6" fill="#111" stroke="#fff" stroke-width="0.8" /><rect x="14" y="2.5" width="9" height="5" fill="#a3e635" fill-opacity="0.7" /><rect x="14" y="2.5" width="14" height="5" fill="none" stroke="#a3e635" stroke-width="0.8" stroke-dasharray="1.5 1" /></svg>Ramp (filled = how far out; amber = not out in time)</span>
</div>

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--text);
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  svg {
    width: 30px;
    height: 10px;
  }
</style>
