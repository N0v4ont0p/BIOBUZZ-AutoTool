<script lang="ts">
  interface Props {
    label: string;
    /** Roomier padding for cells that hold controls rather than a bare value. */
    roomy?: boolean;
    valueClass?: string;
    children?: import("svelte").Snippet;
  }

  let {
    label,
    roomy = false,
    valueClass = "font-medium text-gray-100",
    children,
  }: Props = $props();
</script>

<div
  class="border border-[#333333] bg-[#1f1f1f] px-2"
  class:py-1.5={!roomy}
  class:py-2={roomy}
  class:leading-tight={roomy}
>
  <div class="text-gray-500">{label}</div>
  <div class={valueClass}>{@render children?.()}</div>
</div>
