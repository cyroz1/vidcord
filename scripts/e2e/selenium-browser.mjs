import { writeFileSync } from "node:fs";
import { By, Key, Select } from "selenium-webdriver";

function locator(selector) {
  if (selector.startsWith("button=")) {
    const text = selector.slice("button=".length).replaceAll('"', '\\"');
    return By.xpath(`//button[normalize-space(.)="${text}"]`);
  }
  return By.css(selector);
}

function elementAdapter(driver, resolve) {
  async function getElement() {
    return resolve();
  }

  return {
    async click() {
      const element = await getElement();
      const isCheckbox = await driver.executeScript(
        (target) => target instanceof HTMLInputElement && target.type === "checkbox",
        element
      );
      if (!isCheckbox) {
        await element.click();
        return;
      }

      await driver.executeScript((target) => {
        target.__vidcordE2eChangeSeen = false;
        target.addEventListener(
          "change",
          () => {
            target.__vidcordE2eChangeSeen = true;
          },
          { once: true }
        );
      }, element);
      await element.click();
      const changeWasDispatched = await driver.executeScript(
        (target) => target.__vidcordE2eChangeSeen,
        element
      );
      if (!changeWasDispatched) {
        await driver.executeScript((target) => target.click(), element);
      }
    },
    async getText() {
      return (await getElement()).getText();
    },
    async getAttribute(name) {
      return (await getElement()).getAttribute(name);
    },
    async getValue() {
      return driver.executeScript((element) => element.value, await getElement());
    },
    async isDisplayed() {
      try {
        return await (await getElement()).isDisplayed();
      } catch {
        return false;
      }
    },
    async isEnabled() {
      try {
        return await (await getElement()).isEnabled();
      } catch {
        return false;
      }
    },
    async isSelected() {
      return (await getElement()).isSelected();
    },
    async isExisting() {
      try {
        await getElement();
        return true;
      } catch {
        return false;
      }
    },
    async waitForDisplayed({ timeout = 5000, reverse = false } = {}) {
      await driver.wait(
        async () => {
          const displayed = await this.isDisplayed();
          return reverse ? !displayed : displayed;
        },
        timeout,
        reverse ? "Element remained visible" : "Element did not become visible",
        100
      );
    },
    async scrollIntoView() {
      await driver.executeScript(
        (element) => element.scrollIntoView({ block: "center", inline: "nearest" }),
        await getElement()
      );
    },
    async setValue(value) {
      const element = await getElement();
      await driver.executeScript((target) => {
        target.__vidcordE2eLastInputValue = null;
        target.addEventListener("input", () => {
          target.__vidcordE2eLastInputValue = target.value;
        });
      }, element);
      await element.clear();
      await element.sendKeys(String(value));
      const inputValue = await driver.executeScript(
        (target) => target.__vidcordE2eLastInputValue,
        element
      );
      if (inputValue !== String(value)) {
        await driver.executeScript(
          (target, nextValue) => {
            const prototype =
              target instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, nextValue);
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          },
          element,
          String(value)
        );
      }
    },
    async press(key) {
      const seleniumKey = key === "Enter" ? Key.ENTER : key === "Tab" ? Key.TAB : key;
      await (await getElement()).sendKeys(seleniumKey);
    },
    async selectByAttribute(attribute, value) {
      if (attribute !== "value") throw new Error(`Unsupported select attribute: ${attribute}`);
      await selectOption(driver, await getElement(), String(value), (element) =>
        new Select(element).selectByValue(String(value))
      );
    },
    async selectByIndex(index) {
      const element = await getElement();
      const value = await driver.executeScript(
        (select, optionIndex) => select.options[optionIndex]?.value,
        element,
        index
      );
      if (value === undefined) throw new Error(`Select has no option at index ${index}`);
      await selectOption(driver, element, value, (select) =>
        new Select(select).selectByIndex(index)
      );
    },
    async selectByVisibleText(text) {
      const element = await getElement();
      const value = await driver.executeScript(
        (select, visibleText) =>
          Array.from(select.options).find((option) => option.text.trim() === visibleText.trim())
            ?.value,
        element,
        text
      );
      if (value === undefined) throw new Error(`Select has no option with text ${text}`);
      await selectOption(driver, element, value, (select) =>
        new Select(select).selectByVisibleText(text)
      );
    },
    $(selector) {
      return elementAdapter(driver, async () =>
        (await getElement()).findElement(locator(selector))
      );
    },
    async $$(selector) {
      const elements = await (await getElement()).findElements(locator(selector));
      return elements.map((element) => elementAdapter(driver, async () => element));
    },
  };
}

async function selectOption(driver, element, value, nativeSelection) {
  await driver.executeScript((select) => {
    select.__vidcordE2eChangeSeen = false;
    select.addEventListener(
      "change",
      () => {
        select.__vidcordE2eChangeSeen = true;
      },
      { once: true }
    );
  }, element);
  await nativeSelection(element);
  const changeWasDispatched = await driver.executeScript(
    (select) => select.__vidcordE2eChangeSeen,
    element
  );
  if (changeWasDispatched) return;

  // The embedded Tauri driver can click an option without dispatching the
  // change event that React listens for. Preserve the real WebDriver attempt,
  // then dispatch the same bubbling browser events when that happens.
  await driver.executeScript(
    (select, nextValue) => {
      select.value = nextValue;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    element,
    value
  );
}

export function createSeleniumBrowser(driver) {
  return {
    $(selector) {
      return elementAdapter(driver, () => driver.findElement(locator(selector)));
    },
    async $$(selector) {
      const elements = await driver.findElements(locator(selector));
      return elements.map((element) => elementAdapter(driver, async () => element));
    },
    async waitUntil(condition, { timeout = 5000, interval = 100, timeoutMsg } = {}) {
      await driver.wait(condition, timeout, timeoutMsg, interval);
    },
    async execute(script, ...args) {
      return driver.executeScript(script, ...args);
    },
    async saveScreenshot(filePath) {
      const screenshot = await driver.takeScreenshot();
      writeFileSync(filePath, Buffer.from(screenshot, "base64"));
    },
    async pause(milliseconds) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },
  };
}
