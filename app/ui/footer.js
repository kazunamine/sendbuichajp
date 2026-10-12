const html = require('choo/html');
const Component = require('choo/component');

class Footer extends Component {
  constructor(name, state) {
    super(name);
    this.state = state;
  }

  update() {
    return false;
  }

  createElement() {
    const translate = this.state.translate;

    const li = 'm-2';
    const ext = 'noopener noreferrer';
    const links = [
      html`
        <li class="${li}">
          <a href="/terms">${translate('buichaTermsTitle')}</a>
        </li>
      `,
      html`
        <li class="${li}">
          <a href="/privacy">${translate('buichaPrivacyTitle')}</a>
        </li>
      `,
      html`
        <li class="${li}">
          <a
            href="https://github.com/kazunamine/sendbuichajp"
            target="_blank"
            rel="${ext}"
          >
            ${translate('buichaSourceCode')}
          </a>
        </li>
      `,
      html`
        <li class="${li}">
          <a href="https://apps.buicha.jp" target="_blank" rel="${ext}">
            apps.buicha.jp
          </a>
        </li>
      `,
      html`
        <li class="${li}">
          <a
            href="https://links.buicha.jp/contacts"
            target="_blank"
            rel="${ext}"
          >
            ${translate('buichaContact')}
          </a>
        </li>
      `
    ];

    // Optional additional links from configuration
    if (this.state != undefined && this.state.WEB_UI != undefined) {
      const WEB_UI = this.state.WEB_UI;
      if (WEB_UI.FOOTER_DONATE_URL != '') {
        links.push(html`
          <li class="${li}">
            <a href="${WEB_UI.FOOTER_DONATE_URL}" target="_blank">
              ${translate('footerLinkDonate')}
            </a>
          </li>
        `);
      }
      if (WEB_UI.FOOTER_CLI_URL != '') {
        links.push(html`
          <li class="${li}">
            <a href="${WEB_UI.FOOTER_CLI_URL}" target="_blank">
              ${translate('footerLinkCli')}
            </a>
          </li>
        `);
      }
      if (WEB_UI.FOOTER_DMCA_URL != '') {
        links.push(html`
          <li class="${li}">
            <a href="${WEB_UI.FOOTER_DMCA_URL}" target="_blank">
              ${translate('footerLinkDmca')}
            </a>
          </li>
        `);
      }
    }

    // Defining a custom footer
    var footer = [
      html`
        <li class="m-2">
          Based on
          <a
            class="underline"
            href="https://github.com/timvisee/send"
            target="_blank"
            rel="noopener noreferrer"
            >timvisee/send</a
          >
          (MPL-2.0)
        </li>
      `
    ];
    if (this.state != undefined && this.state.WEB_UI != undefined) {
      const WEB_UI = this.state.WEB_UI;

      if (WEB_UI.CUSTOM_FOOTER_URL != '' && WEB_UI.CUSTOM_FOOTER_TEXT != '') {
        footer.push(html`
          <li class="m-2">
            <a href="${WEB_UI.CUSTOM_FOOTER_URL}" target="_blank">
              ${WEB_UI.CUSTOM_FOOTER_TEXT}
            </a>
          </li>
        `);
      } else if (WEB_UI.CUSTOM_FOOTER_URL != '') {
        footer.push(html`
          <li class="m-2">
            <a href="${WEB_UI.CUSTOM_FOOTER_URL}" target="_blank">
              ${WEB_UI.CUSTOM_FOOTER_URL}
            </a>
          </li>
        `);
      } else if (WEB_UI.CUSTOM_FOOTER_TEXT != '') {
        footer.push(html`
          <li class="m-2">
            ${WEB_UI.CUSTOM_FOOTER_TEXT}
          </li>
        `);
      } else {
        footer.push(html`
          <li class="m-2">
            ${translate('footerText')}
          </li>
        `);
      }
    }

    return html`
      <footer
        class="flex flex-col md:flex-row items-start w-full flex-none self-start p-6 md:p-8 font-medium text-xs md:items-center justify-between"
      >
        <ul
          class="flex flex-col md:flex-row items-start md:items-center md:justify-start"
        >
          ${footer}
        </ul>
        <ul
          class="flex flex-col md:flex-row md:flex-wrap items-start md:items-center md:justify-end"
        >
          ${links}
        </ul>
      </footer>
    `;
  }
}

module.exports = Footer;
