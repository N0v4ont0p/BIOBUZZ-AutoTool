<script lang="ts">
  import { showRuler, showProtractor, showGrid } from "../stores";
  import FieldGrid from "./components/mathtools/FieldGrid.svelte";
  import RulerOverlay from "./components/mathtools/RulerOverlay.svelte";
  import ProtractorOverlay from "./components/mathtools/ProtractorOverlay.svelte";
  import type * as d3 from "d3";

  interface Props {
    x: d3.ScaleLinear<number, number>;
    y: d3.ScaleLinear<number, number>;
    twoElement: HTMLDivElement;
    robotXY: { x: number; y: number };
  }

  let { x, y, twoElement, robotXY }: Props = $props();
</script>

{#if $showGrid}
  <FieldGrid {x} {y} />
{/if}

{#if $showRuler}
  <RulerOverlay {x} {y} {twoElement} />
{/if}

{#if $showProtractor}
  <ProtractorOverlay {x} {y} {twoElement} {robotXY} />
{/if}
