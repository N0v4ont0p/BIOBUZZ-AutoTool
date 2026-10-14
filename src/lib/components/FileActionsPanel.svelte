<script lang="ts">
  import type { FileInfo } from "../../types";
  import PencilIcon from "./icons/PencilIcon.svelte";
  import TrashIcon from "./icons/TrashIcon.svelte";
  import PlusIcon from "./icons/PlusIcon.svelte";

  interface Props {
    selectedFile: FileInfo | null;
    onRename: (file: FileInfo) => void;
    onDelete: (file: FileInfo) => void;
    onDuplicate: () => void;
    onDuplicateAndMirror: () => void;
    onOverwrite: () => void;
    onNew: () => void;
    onDownload: () => void;
    onSaveToLocalFile: () => void;
  }

  let {
    selectedFile,
    onRename,
    onDelete,
    onDuplicate,
    onDuplicateAndMirror,
    onOverwrite,
    onNew,
    onDownload,
    onSaveToLocalFile,
  }: Props = $props();

  const ICON_BTN = "console-action console-action--compact";
  const SAVE_BTN = "console-action console-action--compact gap-1";
</script>

{#if selectedFile}
  <div class="file-drawer-band file-drawer-band--footer shrink-0 p-3 space-y-2">
    <div class="module-mono">
      {selectedFile.name}
    </div>

    <!-- File Operations (Rename, Delete, Duplicate) -->
    <div class="grid grid-cols-3 gap-1">
      <button
        onclick={() => selectedFile && onRename(selectedFile)}
        class={ICON_BTN}
        title="Rename this file"
      >
        <PencilIcon className="size-3.5" strokeWidth={2} />
      </button>

      <button
        onclick={() => selectedFile && onDelete(selectedFile)}
        class="{ICON_BTN} console-action--danger"
        title="Delete this file"
      >
        <TrashIcon className="size-3.5" strokeWidth={2} />
      </button>

      <button
        onclick={onDuplicate}
        class={ICON_BTN}
        title="Duplicate this file"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width={2}
          stroke="currentColor"
          class="size-3.5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"
          />
        </svg>
      </button>
    </div>

    <!-- Mirror Button - Full Width -->
    <button
      onclick={onDuplicateAndMirror}
      class="console-action console-action--accent w-full text-sm"
      title="Create a mirrored copy of this path"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width={2}
        stroke="currentColor"
        class="size-5"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
        />
      </svg>
      <span>Duplicate &amp; Mirror Path</span>
    </button>

    <!-- Saving Operations -->
    <div class="space-y-1">
      <div class="file-drawer-caption px-1">Save Options</div>
      <div class="grid grid-cols-2 gap-1">
        <button
          onclick={onOverwrite}
          class={SAVE_BTN}
          disabled={!selectedFile}
          title="Save into selected file (overwrite)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width={2}
            stroke="currentColor"
            class="size-3.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M3 7.5A2.25 2.25 0 0 1 5.25 5.25h13.5A2.25 2.25 0 0 1 21 7.5v9a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 16.5v-9zM7.5 11.25h9M7.5 14.25h6"
            />
          </svg>
          Overwrite
        </button>
        <button
          onclick={onNew}
          class={SAVE_BTN}
          title="Create new file and save"
        >
          <PlusIcon className="size-3.5" strokeWidth={2} />
          New
        </button>
        <button
          onclick={onDownload}
          class={SAVE_BTN}
          title="Download .pp to computer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width={2}
            stroke="currentColor"
            class="size-3.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 3v12m0 0 3-3m-3 3-3-3M21 21H3"
            />
          </svg>
          Download
        </button>
        <button
          onclick={onSaveToLocalFile}
          class={SAVE_BTN}
          title="Save to local file"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width={2}
            stroke="currentColor"
            class="size-3.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 12v6m0-6V6m0 6l3-3m-3 3-3-3"
            />
          </svg>
          Local
        </button>
      </div>
    </div>
  </div>
{:else}
  <div
    class="file-drawer-band file-drawer-band--footer module-caption shrink-0 p-3 text-center"
  >
    Select a file to manage
  </div>
{/if}
