<script lang="ts">
  import { fly } from "svelte/transition";
  import { toasts, type ToastType } from "../../toast";

  const TYPE_CLASSES: Record<ToastType, string> = {
    success: "bg-green-500 text-white",
    error: "bg-red-500 text-white",
    warning: "bg-amber-500 text-white",
    info: "bg-blue-500 text-white",
  };
</script>

<div
  class="fixed bottom-4 right-4 z-3000 flex flex-col items-end gap-2"
  aria-live="polite"
>
  {#each $toasts as toast (toast.id)}
    <div
      transition:fly={{ duration: 200, y: 8 }}
      class="px-4 py-2 rounded-md shadow-lg {TYPE_CLASSES[toast.type]}"
      role="status"
    >
      {toast.message}
    </div>
  {/each}
</div>
