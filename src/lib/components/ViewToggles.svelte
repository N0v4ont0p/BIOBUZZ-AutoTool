<script lang="ts">
  import {
    snapToGrid,
    showGrid,
    showRuler,
    showProtractor,
    protractorLockToRobot,
  } from "../../stores";

  interface Props {
    selectedGridSize: number;
    onCycleGridSize: () => void;
  }

  let { selectedGridSize, onCycleGridSize }: Props = $props();

  const SVG_PROPS = {
    xmlns: "http://www.w3.org/2000/svg",
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
  };
</script>

<!-- Snap to grid toggle -->
{#if $showGrid}
  <button
    title={$snapToGrid ? "Disable Snap to Grid" : "Enable Snap to Grid"}
    onclick={() => snapToGrid.update((v) => !v)}
    class:text-[#888888]={$snapToGrid && $showGrid}
    class:text-gray-400={!$showGrid}
    class:opacity-50={!$showGrid}
    class="console-icon-button"
    disabled={!$showGrid}
  >
    <svg
      {...SVG_PROPS}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <!-- When snapped, show magnet icon -->
      <path
        d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"
      ></path>
      <path d="m5 8 4 4"></path>
      <path d="m12 15 4 4"></path>

      <!-- If the snap is disabled, turn the icon grey, not white -->
      {#if !$snapToGrid}
        <line x1="23" y1="23" x2="1" y2="1" class="opacity-50"></line>
      {/if}
    </svg>
  </button>
{/if}

<!-- Grid toggle -->
<button
  title={$showGrid
    ? `Grid: ${selectedGridSize}" (click to cycle)`
    : "Toggle Grid"}
  onclick={onCycleGridSize}
  class:text-blue-500={$showGrid}
  class="console-icon-button relative"
>
  <svg
    {...SVG_PROPS}
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="3" y1="9" x2="21" y2="9"></line>
    <line x1="3" y1="15" x2="21" y2="15"></line>
    <line x1="9" y1="3" x2="9" y2="21"></line>
    <line x1="15" y1="3" x2="15" y2="21"></line>
  </svg>
  {#if $showGrid}
    <span
      class="absolute -bottom-5 left-1/2 -translate-x-1/2 text-xs font-semibold whitespace-nowrap"
    >
      {selectedGridSize}"
    </span>
  {/if}
</button>

<!-- Ruler toggle -->
<button
  title="Toggle Ruler"
  onclick={() => showRuler.update((v) => !v)}
  class:text-blue-500={$showRuler}
  class="console-icon-button"
>
  <svg
    {...SVG_PROPS}
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path
      d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0z"
    ></path>
    <path d="m14.5 12.5 2-2"></path>
    <path d="m11.5 9.5 2-2"></path>
    <path d="m8.5 6.5 2-2"></path>
    <path d="m17.5 15.5 2-2"></path>
  </svg>
</button>

<!-- Protractor lock to robot toggle -->
{#if $showProtractor}
  <button
    title={$protractorLockToRobot
      ? "Unlock Protractor from Robot"
      : "Lock Protractor to Robot"}
    onclick={() => protractorLockToRobot.update((v) => !v)}
    class:text-amber-500={$protractorLockToRobot}
    class="console-icon-button"
  >
    <svg
      {...SVG_PROPS}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      {#if $protractorLockToRobot}
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      {:else}
        <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
      {/if}
    </svg>
  </button>
{/if}

<!-- Protractor toggle -->
<button
  title="Toggle Protractor"
  onclick={() => showProtractor.update((v) => !v)}
  class:text-blue-500={$showProtractor}
  class="console-icon-button"
>
  <svg
    {...SVG_PROPS}
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M12 21a9 9 0 1 1 0-18c2.52 0 4.93 1 6.74 2.74L21 8"></path>
    <path d="M12 3v6l3.7 2.7"></path>
  </svg>
</button>
