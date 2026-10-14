<script lang="ts">
  interface Props {
    side: "left" | "right";
    hidden?: boolean;
    onResizeStart: (side: "left" | "right", event: MouseEvent) => void;
    onRestore: () => void;
  }

  let { side, hidden = false, onResizeStart, onRestore }: Props = $props();

  let label = $derived(side === "left" ? "left" : "right");
  // The chevron points toward the direction the panel would reappear from.
  let collapsedGlyph = $derived(side === "left" ? "›" : "‹");
</script>

<!-- The divider stays put when its panel is hidden: it is the handle that
     brings the panel back, alongside the navbar toggle. -->
<div class="panel-divider panel-divider--{side}">
  <button
    class="panel-divider-grip"
    class:panel-divider-grip--restore={hidden}
    type="button"
    aria-label={hidden ? `Show ${label} panel` : `Resize ${label} panel`}
    title={hidden
      ? `Click to restore the ${label} panel`
      : `Drag to resize the ${label} panel`}
    onmousedown={(event) => {
      if (!hidden) onResizeStart(side, event);
    }}
    onclick={() => {
      if (hidden) onRestore();
    }}
  >
    {#if hidden}
      {collapsedGlyph}
    {:else}
      <span class="panel-divider-line"></span>
    {/if}
  </button>
</div>
