<script lang="ts">
  import Modal from "./ui/Modal.svelte";

  interface Props {
    isOpen?: boolean;
    progress?: number;
    statusMessage?: string;
    onCancel?: () => void;
  }

  let {
    isOpen = false,
    progress = 0,
    statusMessage = "Processing...",
    onCancel = () => {},
  }: Props = $props();

  let progressPercentage = $derived(Math.round(progress * 100));
</script>

<Modal
  {isOpen}
  titleId="progress-title"
  closeOnEscape={false}
  closeOnBackdrop={false}
>
  <h2 id="progress-title" class="text-xl font-semibold text-[#e8e8e8] mb-4">
    Exporting GIF
  </h2>

  <div class="mb-4">
    <div class="flex justify-between items-center mb-2">
      <span class="text-sm text-[#d0d0d0]">{statusMessage}</span>
      <span class="text-sm font-semibold text-[#e8e8e8]">
        {progressPercentage}%
      </span>
    </div>

    <!-- Progress bar -->
    <div class="w-full bg-[#333333] rounded-full h-3 overflow-hidden">
      <div
        class="bg-linear-to-r from-blue-500 to-purple-600 h-full rounded-full transition-all duration-300 ease-out"
        style="width: {progressPercentage}%"
      ></div>
    </div>
  </div>

  <div class="flex justify-end">
    <button onclick={onCancel} class="console-action">Cancel</button>
  </div>
</Modal>
