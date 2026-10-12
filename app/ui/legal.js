const html = require('choo/html');
const modal = require('./modal');

const URL_RE = /(https?:\/\/[^\s<>"'）)、。」]+)/g;

// Turns plain text into an array of strings and <a> elements.
// Only http(s) URLs are linked.
function linkify(text) {
  return String(text)
    .split(URL_RE)
    .map((part, i) => {
      if (i % 2 === 1) {
        return html`
          <a href="${part}" target="_blank" rel="noopener noreferrer"
            >${part}</a
          >
        `;
      }
      return part;
    });
}

function section(s) {
  return html`
    <section>
      <h2>${s.heading}</h2>
      ${(s.paragraphs || []).map(
        p =>
          html`
            <p>${linkify(p)}</p>
          `
      )}
      ${s.items && s.items.length
        ? html`
            <ul>
              ${s.items.map(
                i =>
                  html`
                    <li>${linkify(i)}</li>
                  `
              )}
            </ul>
          `
        : ''}
    </section>
  `;
}

// content: { title, updatedAt, intro, sections: [{ heading, paragraphs, items }] }
module.exports = function(content) {
  return function(state, emit) {
    return html`
      <main class="main main-legal">
        ${state.modal && modal(state, emit)}
        <section class="relative w-full p-6 md:p-8">
          <article class="legal">
            <h1>${content.title}</h1>
            <p class="meta">${content.updatedAt}</p>
            <p>${linkify(content.intro)}</p>
            ${content.sections.map(section)}
            <p class="mt-8">
              <a href="/">${state.translate('buichaBackToTop')}</a>
            </p>
          </article>
        </section>
      </main>
    `;
  };
};
