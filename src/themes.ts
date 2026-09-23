// Color presets adapted from Fez’s @fezchat/themes collection. See README for palette credits.
// Dim text and accents are adjusted for readable contrast in Sidecar’s smaller chat type.
type Palette = [base: string, panel: string, raised: string, line: string, ink: string, soft: string, muted: string, accent: string, secondary: string, tertiary: string, code: string, error: string];
export const themes: Record<string, { name: string; dark: Palette; light: Palette }> = {
  "gruvbox": { name: "Gruvbox",
    dark: ["#1d2021","#282828","#32302f","#504945","#ebdbb2","#bdae93","#a89984","#d79921","#83a598","#d3869b","#d5c4a1","#fabd2f"],
    light: ["#fbf1c7","#f2e5bc","#e0d5b0","#bdae93","#3c3836","#504945","#655b53","#85510a","#076678","#8f3f71","#504945","#9d0006"],
  },
  "dracula": { name: "Dracula",
    dark: ["#282a36","#2f3240","#44475a","#44475a","#f8f8f2","#dadde2","#adb6d0","#caa8fa","#f1fa8c","#ff9b9b","#f8f8f2","#ff9b9b"],
    light: ["#fffbeb","#f7f2df","#ece5cc","#e6dfc8","#1f1f1f","#2e2d28","#6c664b","#644ac9","#796513","#bb3527","#1f1f1f","#bb3527"],
  },
  "nord": { name: "Nord",
    dark: ["#2e3440","#3b4252","#434c5e","#434c5e","#eceff4","#d0d5de","#b6bcc8","#8fc4d3","#ebcb8b","#dfb0b5","#eceff4","#dfb0b5"],
    light: ["#eceff4","#e5e9f0","#d8dee9","#c9d2e0","#2e3440","#343b48","#4c566a","#486384","#775f28","#a54049","#2e3440","#a54049"],
  },
  "catppuccin": { name: "Catppuccin",
    dark: ["#1e1e2e","#181825","#313244","#313244","#cdd6f4","#bdc6e2","#969aae","#cba6f7","#f9e2af","#f38ba8","#cdd6f4","#f38ba8"],
    light: ["#eff1f5","#e6e9ef","#dce0e8","#ccd0da","#4c4f69","#595c74","#61636f","#7e35de","#8a5812","#c50e36","#4c4f69","#c50e36"],
  },
  "solarized": { name: "Solarized",
    dark: ["#002b36","#073642","#104a56","#104a56","#a6b2b2","#a6b2b3","#a6b2b6","#78b7e3","#ccae4f","#ee9997","#a6b2b2","#ee9997"],
    light: ["#fdf6e3","#eee8d5","#e4dcc4","#d9d2c0","#50646a","#536469","#5a6262","#1c6599","#795c00","#b72a27","#50646a","#b72a27"],
  },
  "one": { name: "One",
    dark: ["#282c34","#2c313a","#3b4048","#3b4048","#abb2bf","#a5abb7","#a7abb2","#64b1ef","#e5c07b","#e8949a","#abb2bf","#e8949a"],
    light: ["#fafafa","#f0f0f1","#e5e5e6","#dbdbdc","#383a42","#42444d","#636670","#3461c4","#895e01","#b04238","#383a42","#b04238"],
  },
  "tokyo-night": { name: "Tokyo Night",
    dark: ["#1a1b26","#16161e","#292e42","#292e42","#c0caf5","#abb5df","#8f95b1","#7aa2f7","#e0af68","#f7768e","#c0caf5","#f7768e"],
    light: ["#e1e2e7","#d5d6db","#c8c9d1","#c8c9d1","#2e51a0","#365295","#4e536c","#1f549c","#69512f","#a41c44","#2e51a0","#a41c44"],
  },
  "github": { name: "GitHub",
    dark: ["#0d1117","#161b22","#21262d","#30363d","#c9d1d9","#bdc5cd","#8b949e","#58a6ff","#d29922","#f85149","#c9d1d9","#f85149"],
    light: ["#ffffff","#f6f8fa","#eaeef2","#d0d7de","#24292f","#2e343b","#57606a","#0968d8","#926200","#cf222e","#24292f","#cf222e"],
  },
  "rose-pine": { name: "Rosé Pine",
    dark: ["#191724","#1f1d2e","#26233a","#26233a","#e0def4","#d0cee5","#908caa","#ebbcba","#f6c177","#eb6f92","#e0def4","#eb6f92"],
    light: ["#faf4ed","#fffaf3","#f2e9e1","#dfdad9","#575279","#5e597e","#6a6781","#945a57","#8f6020","#995468","#575279","#995468"],
  },
  "everforest": { name: "Everforest",
    dark: ["#2d353b","#272e33","#3d484d","#3d484d","#d3c6aa","#c3bca3","#adb6b0","#a7c080","#dbbc7f","#eda0a1","#d3c6aa","#eda0a1"],
    light: ["#fdf6e3","#f4f0d9","#efebd4","#e6e2cc","#5c6a72","#5f6c6e","#646c63","#616f01","#8a6300","#b83f3d","#5c6a72","#b83f3d"],
  },
  "monokai": { name: "Monokai",
    dark: ["#272822","#1e1f1c","#3e3d32","#3e3d32","#f8f8f2","#deddd4","#a9a79b","#fb7fac","#e6db74","#fd8181","#f8f8f2","#fd8181"],
    light: ["#fafaf5","#f0f0ea","#e3e3da","#d8d8cd","#272822","#37372e","#686554","#c21856","#736500","#b13c43","#272822","#b13c43"],
  },
  "night-owl": { name: "Night Owl",
    dark: ["#011627","#001122","#0b2942","#102a44","#d6deeb","#bfc9d4","#819191","#82aaff","#f78c6c","#f05c59","#d6deeb","#f05c59"],
    light: ["#fbfbfb","#f0f0f0","#e4e4e4","#d9d9d9","#403f53","#525266","#616671","#8d46b3","#7c6101","#b33c39","#403f53","#b33c39"],
  },
  "ayu": { name: "Ayu",
    dark: ["#0b0e14","#0f131a","#161a24","#161a24","#bfbdb6","#aaa9a6","#7f828b","#e6b450","#ffb454","#d95757","#bfbdb6","#d95757"],
    light: ["#fcfcfc","#f3f4f5","#e7e8e9","#e0e1e2","#5c6166","#63696e","#63686e","#9a5708","#846300","#b63f3f","#5c6166","#b63f3f"],
  },
  "palenight": { name: "Palenight",
    dark: ["#292d3e","#222634","#3a3f58","#3a3f58","#a6accd","#a4aac9","#a7abc2","#ca99eb","#ffcb6b","#f38f94","#a6accd","#f38f94"],
    light: ["#fafafa","#f0f1f4","#e4e7ec","#d5dbe0","#516b76","#546a74","#5c696f","#7146e8","#8c5d1e","#c0302d","#516b76","#c0302d"],
  },
  "horizon": { name: "Horizon",
    dark: ["#1c1e26","#232530","#2e303e","#2e303e","#d5d8da","#c0c3cc","#9496b0","#ed718e","#fab795","#f76a81","#d5d8da","#f76a81"],
    light: ["#fdf0ed","#f9e8e2","#f0dcd5","#ead4cc","#06060c","#1d1a21","#6d6069","#ae3856","#915525","#b82c52","#06060c","#b82c52"],
  },
  "synthwave-84": { name: "SynthWave ’84",
    dark: ["#262335","#241b2f","#34294f","#34294f","#f0eff1","#dadbe7","#8e94c2","#ff7edb","#fede5d","#fe606a","#f0eff1","#fe606a"],
    light: ["#fdf6fb","#f7ecf5","#eeddeb","#e5d2e2","#2a2139","#3a314a","#695f7b","#bb2266","#7b6200","#c02144","#2a2139","#c02144"],
  },
  "cobalt2": { name: "Cobalt2",
    dark: ["#193549","#15232d","#1f4662","#234e6d","#ffffff","#e5ebee","#9bb3bc","#ffc600","#ff9d00","#ff8baa","#ffffff","#ff8baa"],
    light: ["#f5f9fc","#eaf1f7","#dbe7f0","#cddbe6","#17384c","#244457","#536a7a","#826200","#8f5c00","#bc2d5f","#17384c","#bc2d5f"],
  },
  "zenburn": { name: "Zenburn",
    dark: ["#3f3f3f","#383838","#4f4f4f","#4f4f4f","#dcdccc","#cdcdc0","#c0c0c0","#f0dfaf","#e0cf9f","#ddb8b8","#dcdccc","#ddb8b8"],
    light: ["#f0efe6","#e8e6db","#dbd8ca","#d0cdbd","#3f3f3f","#4b4b47","#5f5f50","#6a5e2f","#6a5e2d","#8b4b4b","#3f3f3f","#8b4b4b"],
  },
  "kanagawa": { name: "Kanagawa",
    dark: ["#1f1f28","#16161d","#2a2a37","#363646","#dcd7ba","#c7c3aa","#92928c","#7e9cd8","#e6c384","#d4777a","#dcd7ba","#d4777a"],
    light: ["#f2ecbc","#e5ddb0","#e7dba0","#d5cea3","#545464","#5a5963","#626054","#46608d","#815800","#aa3647","#545464","#aa3647"],
  },
  "flexoki": { name: "Flexoki",
    dark: ["#100f0f","#1c1b1a","#282726","#343331","#cecdc3","#c0bfb6","#8f8e89","#5a94c6","#d0a215","#da6f65","#cecdc3","#da6f65"],
    light: ["#fffcf0","#f2f0e5","#e6e4d9","#dad8ce","#100f0f","#232221","#676662","#205ea6","#806101","#af3029","#100f0f","#af3029"],
  },
};

const tokens = ["base", "panel", "raised", "line", "ink", "soft", "muted", "accent", "secondary", "tertiary", "code", "error"];
export const themeCss = Object.entries(themes).flatMap(([id, theme]) => (["dark", "light"] as const).map(mode => `:root[data-theme="${id}"][data-mode="${mode}"]{color-scheme:${mode};${theme[mode].map((color, i) => `--${tokens[i]}:${color}`).join(";")}}`)).join("\n");

// Runs in the head before first paint; storage failures must never prevent the inbox from loading.
export const appearanceJs = `
(() => {
  const key = 'sidecar-appearance';
  const themes = ${JSON.stringify(Object.keys(themes))};
  const modes = ['dark', 'light', 'system'];
  const media = matchMedia('(prefers-color-scheme: dark)');
  const read = () => {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
    return {theme: themes.includes(saved?.theme) ? saved.theme : 'gruvbox', mode: modes.includes(saved?.mode) ? saved.mode : 'dark'};
  };
  let appearance = read();
  const paint = () => {
    document.documentElement.dataset.theme = appearance.theme;
    document.documentElement.dataset.mode = appearance.mode === 'system' ? (media.matches ? 'dark' : 'light') : appearance.mode;
  };
  paint();
  media.addEventListener('change', paint);
  document.addEventListener('DOMContentLoaded', () => {
    const theme = document.getElementById('theme'), mode = document.getElementById('color-mode'), note = document.getElementById('appearance-note');
    const sync = () => { theme.value = appearance.theme; mode.value = appearance.mode; paint(); };
    sync();
    const change = () => {
      appearance = {theme: themes.includes(theme.value) ? theme.value : 'gruvbox', mode: modes.includes(mode.value) ? mode.value : 'dark'};
      sync();
      try { localStorage.setItem(key, JSON.stringify(appearance)); note.textContent = 'Saved in this browser.'; }
      catch { note.textContent = 'Applied for now. Could not save in this browser.'; }
    };
    theme.addEventListener('change', change);
    mode.addEventListener('change', change);
    window.addEventListener('storage', event => { if (event.key === key || event.key === null) { appearance = read(); sync(); } });
  });
})();
`;
