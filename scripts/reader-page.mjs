// Locators follow the selected tab even when an action switches documents. Window operations
// such as screenshots and reload still address the one Electron window.
export function readerPage(window) {
  const selector = "iframe.document-reader.active";
  const reader = window.frameLocator(selector);
  const frame = async () => {
    const element = await window.locator(selector).elementHandle();
    try { return await element.contentFrame(); }
    finally { await element.dispose(); }
  };
  return {
    window, keyboard: window.keyboard, mouse: window.mouse,
    locator: reader.locator.bind(reader), getByRole: reader.getByRole.bind(reader),
    getByLabel: reader.getByLabel.bind(reader), getByTitle: reader.getByTitle.bind(reader),
    getByText: reader.getByText.bind(reader),
    evaluate: async (...args) => (await frame()).evaluate(...args),
    waitForFunction: async (...args) => (await frame()).waitForFunction(...args),
    on: window.on.bind(window), reload: window.reload.bind(window),
    title: window.title.bind(window), screenshot: window.screenshot.bind(window),
    waitForTimeout: window.waitForTimeout.bind(window), waitForEvent: window.waitForEvent.bind(window),
  };
}
