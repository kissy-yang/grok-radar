let language = 'zh-CN';

export function setLanguage(value) {
  language = value === 'en' ? 'en' : 'zh-CN';
  return language;
}

export function currentLanguage() {
  return language;
}

export const tr = (chinese, english) => language === 'en' ? english : chinese;

const originalLabels = new WeakMap();

export function localizeDocument(doc) {
  doc.documentElement.lang = language;
  const fields = [
    ['data-en', null],
    ['data-en-title', 'title'],
    ['data-en-aria-label', 'aria-label'],
    ['data-en-placeholder', 'placeholder'],
  ];
  for (const [marker, attribute] of fields) {
    for (const node of doc.querySelectorAll(`[${marker}]`)) {
      if (!originalLabels.has(node)) originalLabels.set(node, new Map());
      const labels = originalLabels.get(node);
      if (!labels.has(marker)) labels.set(marker, attribute ? node.getAttribute(attribute) : node.textContent);
      const value = tr(labels.get(marker), node.getAttribute(marker));
      if (attribute) node.setAttribute(attribute, value);
      else node.textContent = value;
    }
  }
}
