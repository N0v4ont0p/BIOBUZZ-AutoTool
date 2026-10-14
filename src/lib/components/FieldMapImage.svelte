<script lang="ts">
  interface Props {
    src: string;
    fieldMapName: string | undefined;
    onSettled?: () => void;
  }

  let { src, fieldMapName, onSettled = () => {} }: Props = $props();

  const FALLBACK_FIELD_MAP = "/fields/decode.webp";
</script>

<img
  {src}
  alt="Field"
  class="absolute top-0 left-0 w-full h-full rounded-lg z-10"
  style="
    background: transparent;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    user-drag: none;
    -webkit-user-drag: none;
    -moz-user-drag: none;
    -ms-user-drag: none;
    -o-user-drag: none;
  "
  draggable="false"
  onload={onSettled}
  onerror={(e) => {
    console.error("Failed to load field map:", fieldMapName);
    onSettled();
    (e.currentTarget as HTMLImageElement).src = FALLBACK_FIELD_MAP;
  }}
  ondragstart={(e) => e.preventDefault()}
  onselectstart={(e) => e.preventDefault()}
/>
