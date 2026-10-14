<script lang="ts">
  import type { Settings } from "../../../types";
  import { imageToBase64 } from "../../../utils/file";
  import { showToast } from "../../toast";

  interface Props {
    settings: Settings;
  }

  let { settings = $bindable() }: Props = $props();

  const DEFAULT_ROBOT_IMAGE = "/robot.png";
  const POTATO_IMAGE = "/JefferyThePotato.png";
  const DUCK_IMAGE = "/MecanumDuck.png";

  // Narrowed value so the template can use it without optional checks.
  let customImage = $derived(
    settings.robotImage && settings.robotImage !== DEFAULT_ROBOT_IMAGE
      ? settings.robotImage
      : null,
  );
  let isCustom = $derived(customImage !== null);

  function setImage(src: string) {
    settings.robotImage = src;
    settings = { ...settings }; // Force reactivity
  }

  async function handleUpload(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const base64 = await imageToBase64(file);
      settings.robotImage = base64;
      // Automatically enable heading arrow when custom robot image is uploaded
      settings.showHeadingArrow = true;
      settings = { ...settings };
      showToast("Robot image updated!", "success");
    } catch (error) {
      alert(
        "Error loading image: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
</script>

<div>
  <div
    class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
  >
    Robot Image
    <div class="text-xs text-neutral-500 dark:text-neutral-400">
      Upload a custom image for your robot
    </div>
  </div>
  <div class="console-section flex flex-col items-center gap-3 p-4">
    <!-- Current robot image preview -->
    <div
      class="relative w-20 h-20 border-2 border-neutral-300 dark:border-neutral-600 overflow-hidden bg-white dark:bg-neutral-900"
    >
      <img
        src={settings.robotImage || DEFAULT_ROBOT_IMAGE}
        alt="Robot Preview"
        class="w-full h-full object-contain"
        onerror={(e) => {
          console.error("Failed to load robot image:", settings.robotImage);
          (e.currentTarget as HTMLImageElement).src = DEFAULT_ROBOT_IMAGE;
        }}
      />
      {#if isCustom}
        <button
          onclick={() => setImage(DEFAULT_ROBOT_IMAGE)}
          class="console-action absolute top-1 right-1 p-1 bg-red-500 text-white hover:bg-red-600 transition-colors"
          title="Remove custom image"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="size-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      {/if}
    </div>

    <!-- Image info -->
    <div class="text-center text-xs text-neutral-600 dark:text-neutral-400">
      {#if customImage}
        <p class="font-medium">
          {#if customImage === POTATO_IMAGE}
            <span class="inline-flex items-center gap-1">
              <span>🥔</span>
              <span>Jeffery the Potato Active!</span>
              <span>🥔</span>
            </span>
          {:else if customImage === DUCK_IMAGE}
            <span>Mecanum Duck Active!</span>
          {:else}
            Custom Image Loaded
          {/if}
        </p>
        <p class="truncate max-w-[160px]" title={customImage.substring(0, 100)}>
          {#if customImage === POTATO_IMAGE}
            Best. Robot. Ever. 🥔
          {:else if customImage === DUCK_IMAGE}
            Quack Quack
          {:else}
            {customImage.substring(0, 30)}...
          {/if}
        </p>
      {:else}
        <p>Using default robot image</p>
      {/if}
    </div>

    <!-- Upload button -->
    <div class="flex flex-col gap-2 w-full">
      <input
        id="robot-image-input"
        type="file"
        accept="image/*"
        class="hidden"
        onchange={handleUpload}
      />
      <button
        onclick={() => document.getElementById("robot-image-input")?.click()}
        class="console-action px-4 py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white transition-colors flex items-center justify-center gap-2"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="size-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        Upload Robot Image
      </button>

      <button
        onclick={() => setImage(DEFAULT_ROBOT_IMAGE)}
        class="console-action px-4 py-2 text-sm bg-neutral-500 hover:bg-neutral-600 text-white transition-colors"
        disabled={!isCustom}
      >
        Use Default Image
      </button>

      <button
        onclick={() => setImage(POTATO_IMAGE)}
        class="potato-tooltip console-action px-4 py-2 text-sm bg-amber-700 hover:bg-amber-800 text-white transition-colors flex items-center justify-center gap-2 group relative overflow-hidden"
        style="background-image: linear-gradient(45deg, #a16207 25%, #ca8a04 25%, #ca8a04 50%, #a16207 50%, #a16207 75%, #ca8a04 75%, #ca8a04 100%); background-size: 20px 20px;"
        title="Transform your robot into Jeffery the Potato!"
      >
        <span
          class="text-lg group-hover:scale-110 transition-transform duration-300"
          >🥔</span
        >
        <span class="font-semibold">Use Potato Robot</span>
        <span class="text-lg opacity-80">🥔</span>

        <!-- Fun hover effect -->
        <div
          class="absolute inset-0 bg-linear-to-r from-transparent via-yellow-200/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"
        ></div>
      </button>

      <button
        onclick={() => setImage(DUCK_IMAGE)}
        class="console-action px-4 py-2 text-sm text-white transition-colors flex items-center justify-center gap-2"
        style="background-image: linear-gradient(45deg, #eab308 25%, #f59e0b 25%, #f59e0b 50%, #eab308 50%, #eab308 75%, #f59e0b 75%, #f59e0b 100%); background-size: 18px 18px;"
        title="Use the Mecanum Duck robot image"
      >
        <span class="font-semibold">Use Mecanum Duck</span>
      </button>
    </div>

    <div
      class="text-xs text-neutral-500 dark:text-neutral-400 text-center mt-1"
    >
      <p>Supported: PNG, JPG, GIF</p>
      <p>Recommended: &lt; 1MB, transparent background</p>
    </div>
  </div>
</div>

<style>
  .potato-tooltip {
    position: relative;
  }

  .potato-tooltip::after {
    content: "🥔 P O T A T O   P O W E R 🥔";
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%) translateY(-10px);
    background: linear-gradient(to right, #a16207, #ca8a04, #a16207);
    color: white;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: bold;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 0.3s,
      transform 0.3s;
    z-index: 1000;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    border: 2px solid #92400e;
  }

  .potato-tooltip:hover::after {
    opacity: 1;
    transform: translateX(-50%) translateY(-5px);
  }
</style>
