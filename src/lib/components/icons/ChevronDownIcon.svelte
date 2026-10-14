<script lang="ts">
  interface Props {
    className?: string;
    strokeWidth?: number;
    rotated?: boolean;
  }

  let {
    className = "size-5",
    strokeWidth = 2,
    rotated = false,
  }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  fill="none"
  viewBox="0 0 24 24"
  stroke-width={strokeWidth}
  stroke="currentColor"
  class={className}
  class:rotate-180={rotated}
>
  <path
    stroke-linecap="round"
    stroke-linejoin="round"
    d="m19.5 8.25-7.5 7.5-7.5-7.5"
  />
</svg>
