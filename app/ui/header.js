const html = require('choo/html');
const Component = require('choo/component');
const Account = require('./account');
const assets = require('../../common/assets');
const { platform } = require('../utils');

class Header extends Component {
  constructor(name, state, emit) {
    super(name);
    this.state = state;
    this.emit = emit;
    this.account = state.cache(Account, 'account');
  }

  update() {
    this.account.render();
    return false;
  }

  createElement() {
    let assetMap = {};
    if (this.state.ui !== undefined) assetMap = this.state.ui.assets;
    else
      assetMap = {
        icon:
          this.state.WEB_UI.CUSTOM_ASSETS.icon !== ''
            ? this.state.WEB_UI.CUSTOM_ASSETS.icon
            : assets.get('icon.png'),
        // icon を差し替えているときは Dark 版を使わない
        icon_dark:
          this.state.WEB_UI.CUSTOM_ASSETS.icon !== ''
            ? ''
            : assets.get('icon-dark.png'),
        wordmark:
          this.state.WEB_UI.CUSTOM_ASSETS.wordmark !== ''
            ? this.state.WEB_UI.CUSTOM_ASSETS.wordmark
            : assets.get('wordmark.svg') + '#logo'
      };
    // 暗い配色のときは Dark 版のロゴ（icon_dark が空なら使わない）
    const useDark = !!assetMap.icon_dark;
    const logo = (alt = '') => html`
      <picture>
        ${useDark
          ? html`
              <source
                media="(prefers-color-scheme: dark)"
                srcset="${assetMap.icon_dark}"
              />
            `
          : ''}
        <img alt="${alt}" src="${assetMap.icon}" />
      </picture>
    `;
    const title =
      platform() === 'android'
        ? html`
            <a class="flex flex-row items-center">
              ${logo()}
              <span class="wordmark">${this.state.translate('title')}</span>
            </a>
          `
        : html`
            <a class="flex flex-row items-center" href="/">
              ${logo(this.state.translate('title'))}
              <span class="wordmark">${this.state.translate('title')}</span>
            </a>
          `;
    return html`
      <header
        class="main-header relative flex-none flex flex-row items-center justify-between w-full px-6 md:px-8 h-16 md:h-24 z-20 bg-transparent"
      >
        ${title} ${this.account.render()}
      </header>
    `;
  }
}

module.exports = Header;
