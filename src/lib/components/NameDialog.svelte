<script lang="ts">
  import { run } from "svelte/legacy";

  import Modal from "./ui/Modal.svelte";

  interface Props {
    isOpen?: boolean;
    title?: string;
    defaultValue?: string;
    placeholder?: string;
    onConfirm?: (name: string) => void;
    onCancel?: () => void;
  }

  let {
    isOpen = $bindable(false),
    title = "Enter Name",
    defaultValue = "",
    placeholder = "Enter name...",
    onConfirm = () => {},
    onCancel = () => {},
  }: Props = $props();

  // Seeded from `defaultValue` each time the dialog opens (see below).
  let inputValue = $state("");
  let inputElement = $state<HTMLInputElement>();
  let lastOpenState = $state(false);

  // Only initialize when dialog first opens, not on every reactive update
  run(() => {
    if (isOpen && !lastOpenState) {
      lastOpenState = true;
      inputValue = defaultValue;
      setTimeout(() => {
        inputElement?.focus();
        inputElement?.select();
      }, 100);
    } else if (!isOpen) {
      lastOpenState = false;
    }
  });

  function handleConfirm() {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onConfirm(trimmed);
      isOpen = false;
    }
  }

  function handleCancel() {
    onCancel();
    isOpen = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      handleConfirm();
    }
  }
</script>

<Modal {isOpen} titleId="name-dialog-title" onClose={handleCancel}>
  <h2 id="name-dialog-title" class="text-xl font-semibold text-[#e8e8e8] mb-4">
    {title}
  </h2>

  <div class="mb-6">
    <input
      bind:this={inputElement}
      bind:value={inputValue}
      onkeydown={handleKeydown}
      type="text"
      {placeholder}
      class="console-input px-4 py-3"
    />
  </div>

  <div class="flex justify-end gap-3">
    <button onclick={handleCancel} class="console-action">Cancel</button>
    <button
      onclick={handleConfirm}
      disabled={!inputValue.trim()}
      class="console-action console-action--accent"
    >
      Confirm
    </button>
  </div>
</Modal>
