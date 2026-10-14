<script lang="ts">
  import Modal from "./ui/Modal.svelte";

  interface Props {
    isOpen?: boolean;
  }

  let { isOpen = $bindable(false) }: Props = $props();

  function dispatchSave(target: "first" | "second" | "both") {
    window.dispatchEvent(
      new CustomEvent("saveDualPath", { detail: { target } }),
    );
    isOpen = false;
  }

  function close() {
    isOpen = false;
  }
</script>

<Modal {isOpen} titleId="dual-path-save-title" onClose={close}>
  <h2
    id="dual-path-save-title"
    class="text-lg font-semibold text-[#e8e8e8] mb-4"
  >
    Save Path Changes
  </h2>

  <p class="text-sm text-[#888888] mb-6">Which path would you like to save?</p>

  <div class="space-y-3">
    <button
      onclick={() => dispatchSave("first")}
      class="w-full px-4 py-3 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-sm font-medium"
    >
      Save First Path Only
    </button>

    <button
      onclick={() => dispatchSave("second")}
      class="w-full px-4 py-3 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors text-sm font-medium"
    >
      Save Second Path Only
    </button>

    <button
      onclick={() => dispatchSave("both")}
      class="w-full px-4 py-3 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors text-sm font-medium"
    >
      Save Both Paths
    </button>

    <button onclick={close} class="console-action w-full justify-center py-3">
      Cancel
    </button>
  </div>
</Modal>
