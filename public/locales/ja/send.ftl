title = ぶいちゃ便！
importingFile = 読み込み中…
encryptingFile = 暗号化中…
decryptingFile = 復号中…
downloadCount =
    { $num ->
       *[other] { $num } 回のダウンロード
    }
timespanHours =
    { $num ->
       *[other] { $num } 時間
    }
copiedUrl = コピー完了！
unlockInputPlaceholder = パスワード
unlockButtonLabel = 開く
downloadButtonLabel = ダウンロード
downloadFinish = ダウンロード完了
fileSizeProgress = ({ $partialSize } / { $totalSize })
sendYourFilesLink = ぶいちゃ便！でファイルを送る
errorPageHeader = 何か問題が発生しました。
fileTooBig = このファイルは大きすぎるためアップロードできません。上限は { $size } です。
linkExpiredAlt = リンク期限切れ
notSupportedHeader = お使いのブラウザーには対応していません。
notSupportedLink = なぜ私のブラウザーには対応していないのでしょうか？
notSupportedOutdatedDetail = お使いのブラウザーは、ぶいちゃ便！が利用しているウェブ技術に対応していません。ブラウザーを最新版に更新してください。
updateFirefox = Firefox を更新する
deletePopupCancel = キャンセル
deleteButtonHover = 削除
passwordTryAgain = パスワードが正しくありません。再度入力してください。
javascriptRequired = { -send-brand }を使うには JavaScript が必要です
whyJavascript = なぜ JavaScript が必要なのですか？
enableJavascript = JavaScript を有効にして再度試してください。
# A short representation of a countdown timer containing the number of hours and minutes remaining as digits, example "13h 47m"
expiresHoursMinutes = { $hours } 時間 { $minutes } 分
# A short representation of a countdown timer containing the number of minutes remaining as digits, example "56m"
expiresMinutes = { $minutes } 分
# A short status message shown when the user enters a long password
maxPasswordLength = パスワード最長文字数: { $length }
# A short status message shown when there was an error setting the password
passwordSetError = このパスワードは設定できませんでした

## Send version 2 strings

-send-brand = ぶいちゃ便！
-send-short-brand = ぶいちゃ便！
-firefox = Firefox
-mozilla = Mozilla
introTitle = 暗号化して、リンクで送る。
introDescription = { -send-brand }は、ブラウザー上でファイルを暗号化して共有できるサービスです。リンクは期限が来ると自動的に無効になるので、大事なファイルがネット上に残り続けません。
notifyUploadEncryptDone = ファイルが暗号化され、送信する準備ができました
# downloadCount is from the downloadCount string and timespan is a timespanMinutes string. ex. 'Expires after 2 downloads or 25 minutes'
archiveExpiryInfo = 有効期限: { $downloadCount }、または { $timespan } まで
timespanMinutes =
    { $num ->
       *[other] { $num } 分
    }
timespanDays =
    { $num ->
       *[other] { $num } 日
    }
timespanWeeks =
    { $num ->
       *[other] { $num } 週間
    }
fileCount =
    { $num ->
       *[other] { $num } ファイル
    }
# byte abbreviation
bytes = B
# kibibyte abbreviation
kb = KB
# mebibyte abbreviation
mb = MB
# gibibyte abbreviation
gb = GB
# localized number and byte abbreviation. example "2.5MB"
fileSize = { $num }{ $units }
# $size is the size of the file, displayed using the fileSize message as format (e.g. "2.5MB")
totalSize = 合計サイズ: { $size }
# the next line after the colon contains a file name
copyLinkDescription = リンクをコピーしてファイルを共有:
copyLinkButton = リンクをコピー
downloadTitle = ファイルをダウンロード
downloadDescription = このファイルは { -send-brand }で暗号化されて共有されています。リンクは期限が来ると自動的に無効になります。
trySendDescription = 暗号化してリンクで送れる { -send-brand }をお試しください。
# count will always be > 10
tooManyFiles =
    { $count ->
       *[other] 一度にアップロードできるのは { $count } ファイルまでです。
    }
# count will always be > 10
tooManyArchives =
    { $count ->
       *[other] ダウンロードできるのは { $count } 回までです。
    }
expiredTitle = このリンクは期限切れです。
notSupportedDescription = { -send-brand }は、このブラウザーでは動作しません。最新版の { -firefox } や、その他の主要なブラウザーの最新版でお試しください。
downloadFirefox = { -firefox } をダウンロード
legalTitle = { -send-short-brand } プライバシー通知
legalDateStamp = バージョン 1.0, 2019年3月12日時点
# A short representation of a countdown timer containing the number of days, hours, and minutes remaining as digits, example "2d 11h 56m"
expiresDaysHoursMinutes = { $days } 日 { $hours } 時 { $minutes } 分
addFilesButton = アップロードするファイルを選択
uploadButton = アップロード
# the first part of the string 'Drag and drop files or click to send up to 1GB'
dragAndDropFiles = ファイルをドラッグ＆ドロップ
# the second part of the string 'Drag and drop files or click to send up to 1GB'
# $size is the size of the file, displayed using the fileSize message as format (e.g. "2.5MB")
orClickWithSize = または、クリックして最大 { $size } のファイルを送信
addPassword = パスワードで保護
emailPlaceholder = メールアドレスを入力
# $size is the size of the file, displayed using the fileSize message as format (e.g. "2.5MB")
signInSizeBump = ログインすると最大 { $size } のファイルを送信できます
signInOnlyButton = ログイン
accountBenefitTitle = アカウントを作成またはログイン
# $size is the size of the file, displayed using the fileSize message as format (e.g. "2.5MB")
accountBenefitLargeFiles = 最大 { $size } までのファイルを共有
accountBenefitDownloadCount = より多くの人とファイルを共有
accountBenefitTimeLimit =
    { $count ->
       *[other] リンクを { $count } 日間有効化
    }
accountBenefitSync = 様々な端末から共有したファイルを管理
accountBenefitMoz = { -mozilla } の他のサービスについて詳しく見る
signOut = ログアウト
okButton = OK
downloadingTitle = ダウンロード中
noStreamsWarning = このブラウザーでは、この大きさのファイルを復号できません。
noStreamsOptionCopy = リンクをコピーして、別のブラウザーで開く
noStreamsOptionFirefox = Firefox を試す
noStreamsOptionDownload = このブラウザーで続ける
downloadFirefoxPromo = { -send-short-brand } はすべてが新しくなった { -firefox } により提供されています。
# the next line after the colon contains a file name
shareLinkDescription = ファイルへのリンクを共有:
shareLinkButton = リンクを共有
# $name is the name of the file
shareMessage = { -send-brand }で「{ $name }」をダウンロード
trailheadPromo = プライバシーを保護する方法があります。Firefox を試してください。
learnMore = 詳細情報

## ぶいちゃ便！ additions

footerText = 本サービスは Mozilla・Firefox とは無関係です。
buichaDescription = ブラウザー上でファイルを暗号化して送れる、期限付きのファイル共有サービスです。
buichaLargeModeNotice = 10GBを超えるファイルは、24時間後に自動で削除されます。
buichaLargeModeUnavailable = 現在、10GBを超える大容量ファイルの送信を停止しています。
buichaQuotaFull = 保存容量が上限に達しているため、現在アップロードを受け付けていません。
buichaUploadRejectedCapacity = 容量の制限により、アップロードできませんでした。時間をおいて再度お試しください。
buichaTermsTitle = 利用規約
buichaPrivacyTitle = プライバシーポリシー
buichaSourceCode = ソースコード
buichaContact = お問い合わせ
buichaBackToTop = トップへ戻る
