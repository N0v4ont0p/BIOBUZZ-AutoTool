<script lang="ts">
  import ChevronDownIcon from "../icons/ChevronDownIcon.svelte";

  interface Props {
    title: string;
    collapsed?: boolean;
    /** Heroicon `d` path for the leading icon; omit to render title only. */
    iconPath?: string;
    onToggle: () => void;
    children?: import("svelte").Snippet;
  }

  let {
    title,
    collapsed = true,
    iconPath = "",
    onToggle,
    children,
  }: Props = $props();
</script>

<div class="mb-4">
  <button
    onclick={onToggle}
    class="console-trigger w-full justify-between transition-colors duration-250"
    aria-expanded={!collapsed}
  >
    <div class="flex items-center gap-2">
      {#if iconPath}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width={1.5}
          stroke="currentColor"
          class="size-5"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d={iconPath} />
        </svg>
      {/if}
      <span class="font-semibold">{title}</span>
    </div>
    <ChevronDownIcon
      className="size-5 transition-transform duration-200"
      rotated={collapsed}
    />
  </button>

  {#if !collapsed}
    {@render children?.()}
  {/if}
</div>
