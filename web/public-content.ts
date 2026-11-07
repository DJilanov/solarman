import type { PublicLanguage } from "./site-seo";

export type InformationKind = "pricing" | "privacy" | "terms";
export interface InformationSection {
  id: string;
  title: string;
  paragraphs: string[];
  link?: { text: string; url: string };
}
export interface InformationDocument {
  title: string;
  description: string;
  eyebrow: string;
  introduction: string;
  sections: InformationSection[];
}

export const publicDocuments: Record<
  PublicLanguage,
  Record<InformationKind, InformationDocument>
> = {
  en: {
    pricing: {
      title: "A demo first. A clear offer for your home.",
      description:
        "Request a Solarman demo from JILANOVI Ltd. Get an installation compatibility check and an individual written quotation before any paid service.",
      eyebrow: "SERVICES & SUPPORT",
      introduction:
        "We start with your installation and the decisions you want to make. A demo request creates no subscription or payment obligation.",
      sections: [
        {
          id: "demo",
          title: "See the workspace before deciding",
          paragraphs: [
            "Request a demonstration at sales@jilanov.com. Tell us your inverter model and what you want to improve: understanding consumption, keeping battery reserve or planning charging. Do not email your SOLARMAN password, API secret or recovery key.",
            "The public interactive preview uses illustrative states. During a personal demonstration we explain the relevant features and check compatibility before offering access.",
          ],
        },
        {
          id: "offer",
          title: "An individual quotation, agreed in writing",
          paragraphs: [
            "We do not currently sell a fixed-price self-service subscription. You receive a written quotation stating the included monitoring and control features, installation requirements, setup work, total price including applicable VAT, service period and invoicing terms. Paid access begins only after you accept that offer in writing.",
            "There is no automatic card charge or paid conversion from a demo. Payment is by invoice under the accepted quotation. Any renewal, change of scope or third-party API cost is explained and agreed before it becomes payable.",
          ],
        },
        {
          id: "scope",
          title: "What we can help you do",
          paragraphs: [
            "View solar production, household consumption, battery activity and grid use in one workspace, with historical charts and data export. Install the web app (PWA) on iPhone or Android for Home Screen access and optional phone notifications. Configure your own tariff and battery preferences.",
            "Where commercial forecast access is available, compare weather-based solar estimates with recent household consumption and night-charging plans. Estimates depend on the installation information and available readings; they do not guarantee a saving.",
            "Battery reserve and charging controls are offered only for a specifically supported inverter profile after compatibility and commissioning checks. The currently verified control profile is Bluesun BSE20KH3. Monitoring compatibility alone does not establish control compatibility.",
          ],
        },
        {
          id: "setup",
          title: "A guided setup for your own account",
          paragraphs: [
            "We invite you into a separate workspace. You set your dashboard password, link your own SOLARMAN account and select your installation. Shared API capacity is checked before controls are admitted. We help configure your location, panels, battery and tariff, then review monitoring together.",
            "Control enablement is a separate step that needs the supported device, fresh checks and the relevant supervised commissioning evidence. You can keep using monitoring while control requirements are being resolved.",
          ],
        },
        {
          id: "support",
          title: "Reach a person when you need help",
          paragraphs: [
            "Email sales@jilanov.com. Support hours are Monday–Friday, 09:00–18:00 Sofia local time, excluding Bulgarian public holidays. We provide the first response by the next business day. A response is not a promise that the issue will be resolved within that time.",
            "This is not an emergency response or electrical repair service. For an electrical fault or an urgent physical safety problem, use your installation's established emergency procedure and a qualified electrician. Keep access to the native inverter app and local controls.",
          ],
        },
        {
          id: "availability",
          title: "Clear limits before you start",
          paragraphs: [
            "This service depends on SOLARMAN cloud access, internet connectivity, provider quotas and your inverter's firmware. Readings normally arrive at approximately five-minute intervals; control checks may take longer. Delayed readings and uncertain command outcomes are shown explicitly.",
            "Cloud automation cannot guarantee an immediate command during an outage, continuous internet access, physical backup capability or uninterrupted power. Solar and battery hardware keep their native limits and protections. Weather planning for customer accounts requires the appropriate commercial weather access.",
          ],
        },
        {
          id: "cancel",
          title: "Cancel without a hidden checkout",
          paragraphs: [
            "You may request cancellation at sales@jilanov.com. We confirm the end date and any invoice adjustment under your accepted offer and applicable consumer rights. There is no automatic card collection on this website.",
            "You can export workspace data and request account closure from Settings. Service cancellation and permanent data erasure are separate requests; we help reconcile any active inverter control before completing closure.",
          ],
        },
      ],
    },
    privacy: {
      title: "Privacy, explained clearly.",
      description:
        "How JILANOVI Ltd processes Solarman account details, installation readings, provider credentials and optional notifications, and how to exercise your data rights.",
      eyebrow: "PRIVACY NOTICE",
      introduction:
        "JILANOVI Ltd is responsible for the personal data processed in this Solarman service. Contact sales@jilanov.com about your data, account or this notice.",
      sections: [
        {
          id: "data",
          title: "The information we process",
          paragraphs: [
            "Account details include your email address, workspace name, password verifier, invitations, browser-session metadata and security events. If you enable passkeys, we store their public keys, names and verification metadata. We do not receive your fingerprint, face scan or passkey private key.",
            "Connecting SOLARMAN adds your provider account identifier, protected login/API credentials, installation and device identifiers, device settings, readings and control records. Your chosen planning profile may include location coordinates, panel direction and capacity, battery capacity and electricity tariff.",
            "Optional phone notifications require a browser push subscription and delivery records. Optional Telegram delivery uses the destination and bot credential you provide. Support correspondence and quotation/invoice details are processed when you contact us or accept paid service. Hosting and network services also handle connection metadata such as IP addresses.",
          ],
        },
        {
          id: "purposes",
          title: "Why we use it",
          paragraphs: [
            "We process the information necessary to provide the workspace you request: account access, provider connection, monitoring, energy planning, authorized controls, support, export and closure. The legal basis is taking requested steps before a contract and performing the service contract.",
            "We use limited security and operational records to prevent unauthorized access, investigate faults and keep reliable recovery records, relying on our legitimate interest in protecting the service and its users. Statutory accounting records are retained to meet legal obligations. Optional device notifications are requested through your settings and browser permissions; you can disable them. We do not use installation readings for advertising, sell them or publish them as a case study without separate permission.",
          ],
        },
        {
          id: "providers",
          title: "Connections and service providers",
          paragraphs: [
            "SOLARMAN/IGEN receives the authentication and device requests needed for your chosen connection. Forecast requests to Open-Meteo contain the location and panel geometry required for the forecast; dashboard login credentials are not included. These providers also process information under their own service and privacy terms.",
            "If you enable planned-outage checks, ERM Zapad receives the supply-point code you enter for an individual lookup. Area checks read its public publications. The reference is encrypted in our database; the workspace archive contains only its masked hint. You can disable the watch. Away dates and essential-load estimates are used for household planning; optional energy observations compare your own recorded measurements. The public interactive demo uses fictional data and does not contact a connected inverter.",
            "Our hosting, encrypted backup storage (Amazon Web Services) and business email providers process the information needed for those services. If you request browser notifications, your device's push service (for example Apple, Google or Mozilla) receives the encrypted notification delivery. Telegram is contacted only if you configure that optional channel.",
            "Some connected providers operate internationally and may process data outside the EEA. Ask sales@jilanov.com for the current recipients, processing locations and applicable transfer information for your configuration. We review third-party access and any required transfer safeguards before admitting a commercial customer configuration; linking an account is not blanket consent to unrelated use.",
          ],
        },
        {
          id: "security",
          title: "How access is protected",
          paragraphs: [
            "Dashboard passwords use salted one-way password verification. Linked provider credentials and notification secrets are encrypted in storage. Workspace access is separated by account, and sensitive changes require authentication and additional confirmation. Once a passkey is enrolled, password-only sign-in is insufficient.",
            "Backups are encrypted and restore checks keep restored controls and notification delivery inactive until reviewed. These measures reduce risk; no online service can promise absolute security. Report a suspected account issue to sales@jilanov.com.",
          ],
        },
        {
          id: "retention",
          title: "How long information is kept",
          paragraphs: [
            "We keep account and installation history while your workspace is active so you can use its historical analysis and control records. You can inspect and configure automatic retention in Settings → Data and privacy; when enabled, the selected periods govern readings and activity. Without automatic pruning, history remains until it is removed through account closure or another applicable deletion request.",
            "Browser sessions expire after seven days unless revoked earlier. Invitations and administrator recovery links have their displayed expiry. A saved recovery-key verifier remains until it is used, replaced, revoked or the account is removed.",
            "Permanent account erasure removes live credentials and workspace records after active inverter cleanup and deletion-recovery checks. Encrypted backup objects normally become eligible for expiry after 30 days; object versions and storage deletion schedules can extend their physical presence. Minimal deletion records prevent an older backup from restoring a closed account. Records required for accounting, disputes or another legal obligation may be kept for the applicable statutory period.",
          ],
        },
        {
          id: "choices",
          title: "Your choices and rights",
          paragraphs: [
            "You can request access, correction, erasure, restriction, objection or a portable copy of your personal data where applicable. Settings provides a workspace archive and account-closure controls. You may disable optional notifications and revoke recovery access. Contact sales@jilanov.com for assistance or to exercise a right; we may need to verify your identity.",
            "We normally respond to a data-rights request within one month. Where the law allows an extension for a complex request, we explain it. You may complain to Bulgaria's Commission for Personal Data Protection or another competent supervisory authority.",
          ],
          link: {
            text: "Commission for Personal Data Protection",
            url: "https://cpdp.bg/en/",
          },
        },
        {
          id: "storage",
          title: "Cookies and browser storage",
          paragraphs: [
            "The dashboard uses a necessary secure session cookie to keep you signed in and browser storage to remember the interface language. Adding the app to your home screen or enabling notifications uses browser/device capabilities. The notification service worker does not cache or replay authenticated pages, readings or inverter commands.",
            "The site currently has no advertising cookies or third-party marketing analytics. Requesting a demo opens an email draft; the website does not silently submit a lead form. If we add optional analytics or marketing in future, we will update the information and obtain any consent required before enabling it.",
          ],
        },
        {
          id: "changes",
          title: "Changes to this notice",
          paragraphs: [
            "We update this notice when the service or its data processing changes. The version date is shown below. Material changes affecting active customers are communicated through an appropriate account or support channel.",
          ],
        },
      ],
    },
    terms: {
      title: "Straightforward service terms.",
      description:
        "Terms for the Solarman service supplied by JILANOVI Ltd: access, quotations, supported inverter controls, availability, support, cancellation and consumer rights.",
      eyebrow: "SERVICE TERMS",
      introduction:
        "These terms describe the Solarman workspace supplied by JILANOVI Ltd. A written customer quotation specifies the paid scope and price before you accept an order.",
      sections: [
        {
          id: "provider",
          title: "Who supplies the service",
          paragraphs: [
            "The provider is JILANOVI Ltd, company number 205509804, VAT BG205509804, kv. Levski G, bl. 4E, ap. 170, Sofia, Bulgaria. Representative: Nikolai Jilanov. Service and complaints contact: sales@jilanov.com.",
            "This is an independently operated workspace that connects to SOLARMAN OpenAPI. It is not the SOLARMAN manufacturer's own Smart or Business application, and it does not replace your inverter supplier or installer.",
          ],
        },
        {
          id: "agreement",
          title: "Demos, access and paid orders",
          paragraphs: [
            "A demo request or invitation does not create a payment obligation. Access is currently by invitation. Before paid service starts, we send a written quotation stating the features, supported installation, setup work, total price including applicable taxes, service period, payment, renewal and cancellation conditions. The order is accepted in writing; we invoice under that agreed quotation.",
            "The website does not collect card details, automatically charge a demo or silently convert it into a subscription. A quotation cannot remove mandatory consumer rights. We agree material changes to paid scope or price before they become payable.",
          ],
        },
        {
          id: "account",
          title: "Your account and installation",
          paragraphs: [
            "Provide accurate installation and tariff information, use an account and equipment you are entitled to access, and protect your credentials and recovery material. Enter SOLARMAN credentials only in the protected settings flow. Do not send passwords or recovery keys by email.",
            "You remain responsible for the physical installation, suitable electrical protection and the native inverter settings you authorize. An installation's monitoring compatibility does not imply support for control commands. Each workspace's control capability is checked separately, including available API capacity and commissioning evidence.",
          ],
        },
        {
          id: "controls",
          title: "Monitoring and control limitations",
          paragraphs: [
            "Monitoring uses cloud readings and can be delayed, incomplete or unavailable. Charging and reserve features require a specifically supported and commissioned inverter profile. An acknowledged request does not prove the physical result; the service shows verification and unconfirmed outcomes separately.",
            "Commands may arrive late or become unreachable during internet or provider failures. A native charging schedule or reserve setting may remain active while the service cannot communicate. Keep access to the native inverter app and local controls, and follow the documented recovery instructions when needed.",
            "The workspace does not supply physical backup hardware, guarantee power during an outage or replace inverter and battery-management protections. Weather, consumption, charging-time and savings figures are estimates based on available inputs. A fixed saving, uninterrupted supply or immediate cloud response is not promised.",
          ],
        },
        {
          id: "support",
          title: "Support and availability",
          paragraphs: [
            "Support is available at sales@jilanov.com, Monday–Friday 09:00–18:00 Sofia local time, excluding Bulgarian public holidays, with a first response by the next business day. Resolution time depends on the issue and access to the relevant equipment or provider. This is not an emergency response or electrical repair service.",
            "Service depends on hosting, internet connectivity, SOLARMAN access and quotas, device firmware and any optional forecast/notification providers. We may need maintenance or investigation time and will communicate material service issues when practicable. Only a separately agreed written service level creates an additional availability commitment.",
          ],
        },
        {
          id: "cancellation",
          title: "Cancellation, withdrawal and complaints",
          paragraphs: [
            "Request service cancellation or report a complaint at sales@jilanov.com. We confirm the end date, continued access and any invoice adjustment under the accepted offer and mandatory law. You can export your data before requesting permanent account erasure. Closing a workspace may require confirming that active inverter controls have been safely reconciled.",
            "If you are a consumer and conclude a service contract at a distance, you generally have 14 days from conclusion to withdraw. Email a clear withdrawal statement identifying your name, account, contract date and the service. No special form is required. If you expressly request service to begin during that period, the applicable proportionate payment and withdrawal conditions will be explained before you agree. Merely requesting a demo or activating a workspace does not waive those rights.",
            "We handle refunds, service-conformity remedies and disputes according to applicable mandatory law. You may seek assistance from Bulgaria's Commission for Consumer Protection. Nothing in these terms excludes rights or liabilities that the law does not permit us to exclude.",
          ],
          link: {
            text: "Commission for Consumer Protection",
            url: "https://kzp.bg/",
          },
        },
        {
          id: "data",
          title: "Data and acceptable use",
          paragraphs: [
            "The privacy notice explains account and installation data processing, providers, retention, export and erasure. Do not attempt unauthorized access, interfere with another workspace, bypass device protections or use the service to control equipment without permission.",
            "We may restrict access when necessary to address misuse, a security issue, an unresolved payment under an accepted offer or an installation/control problem. We preserve appropriate access to support, recovery and data rights and communicate the reason where lawful and practicable. Suspension is not proof that a physical inverter setting has been removed.",
          ],
        },
        {
          id: "law",
          title: "Applicable law and updates",
          paragraphs: [
            "Bulgarian law applies subject to the mandatory protections available to consumers in their country of habitual residence and any applicable jurisdiction rules. You can use the complaint contact above before seeking another remedy; this does not restrict your right to do so.",
            "The version date appears below. Material changes affecting a paid agreement are communicated before taking effect and handled under that agreement and applicable law.",
          ],
        },
      ],
    },
  },
  bg: {
    pricing: {
      title: "Първо демонстрация. После ясна оферта за твоя дом.",
      description:
        "Заяви демонстрация на Solarman от JILANOVI Ltd. Получи проверка за съвместимост и индивидуална писмена оферта преди платена услуга.",
      eyebrow: "УСЛУГИ И ПОДДРЪЖКА",
      introduction:
        "Започваме с твоята инсталация и решенията, които искаш да вземаш. Заявката за демонстрация не създава абонамент или задължение за плащане.",
      sections: [
        {
          id: "demo",
          title: "Виж платформата, преди да решиш",
          paragraphs: [
            "Заяви демонстрация на sales@jilanov.com. Посочи модела на инвертора и какво искаш да подобриш: разбирането на потреблението, запазването на резерв или планирането на зареждането. Не изпращай паролата си за SOLARMAN, API тайни или ключ за възстановяване по имейл.",
            "Публичният интерактивен преглед използва примерни състояния. При лична демонстрация обясняваме подходящите функции и проверяваме съвместимостта, преди да предложим достъп.",
          ],
        },
        {
          id: "offer",
          title: "Индивидуална оферта, приета писмено",
          paragraphs: [
            "В момента няма абонамент с фиксирана цена и самостоятелно плащане през сайта. Получаваш писмена оферта с включените функции за наблюдение и управление, изискванията към инсталацията, настройката, общата цена с приложимото ДДС, срока на услугата и условията за фактуриране. Платеният достъп започва само след писмено приемане на офертата.",
            "Няма автоматично картово плащане или преминаване от демонстрация към платена услуга. Плащането е по фактура според приетата оферта. Подновяване, промяна на обхвата или разход за външни API услуги се обясняват и съгласуват предварително.",
          ],
        },
        {
          id: "scope",
          title: "С какво можем да помогнем",
          paragraphs: [
            "Виж соларното производство, потреблението на дома, работата на батерията и обмена с мрежата в едно пространство, с исторически графики и износ на данни. Инсталирай уеб приложението (PWA) на iPhone или Android за достъп от началния екран и незадължителни известия. Настрой своята тарифа и предпочитания за батерията.",
            "Когато е осигурен търговски достъп до прогнози, сравнявай очакваната соларна енергия с последното потребление на дома и плановете за нощно зареждане. Оценките зависят от данните за инсталацията и наличните отчитания; не гарантират икономия.",
            "Управление на резерва и зареждането се предлага само за конкретно поддържан профил на инвертор след проверка и изпитване. Текущият проверен профил за управление е Bluesun BSE20KH3. Съвместимостта за наблюдение сама по себе си не означава съвместимост за команди.",
          ],
        },
        {
          id: "setup",
          title: "Водена настройка със собствен акаунт",
          paragraphs: [
            "Получаваш покана за отделно пространство. Задаваш парола за таблото, свързваш собствения си SOLARMAN акаунт и избираш инсталацията. Наличният API капацитет се проверява преди допускане на управление. Помагаме с местоположението, панелите, батерията и тарифата и преглеждаме наблюдението заедно.",
            "Разрешаването на управление е отделна стъпка: изисква поддържано устройство, актуални проверки и необходимите доказателства от изпитване с присъстващ оператор. Наблюдението може да се използва, докато условията за управление се уточняват.",
          ],
        },
        {
          id: "support",
          title: "Свържи се с човек, когато имаш нужда",
          paragraphs: [
            "Пиши на sales@jilanov.com. Поддръжката работи понеделник–петък, 09:00–18:00 по Europe/Sofia, без официалните празници в България. Стремим се към първи отговор до следващия работен ден. Отговорът не е обещание за отстраняване на проблема в същия срок.",
            "Това не е аварийна или електроремонтна услуга. При електрическа повреда или спешен физически риск следвай аварийната процедура на инсталацията и потърси квалифициран електротехник. Запази достъпа до приложението на инвертора и местните контроли.",
          ],
        },
        {
          id: "availability",
          title: "Ясни ограничения още в началото",
          paragraphs: [
            "Услугата зависи от облачния достъп до SOLARMAN, интернет връзката, квотите на доставчика и фърмуера на инвертора. Отчитанията обикновено пристигат през около пет минути; проверките за управление може да отнемат повече време. Закъснели данни и непотвърдени резултати от команди се обозначават отделно.",
            "Облачната автоматизация не гарантира незабавна команда при прекъсване, постоянна интернет връзка, физическа резервна функция или непрекъснато захранване. Инверторът и батерията запазват собствените си ограничения и защити. Прогнозното планиране за клиентски акаунти изисква подходящ търговски достъп до метеорологични данни.",
          ],
        },
        {
          id: "cancel",
          title: "Прекратяване без скрито плащане",
          paragraphs: [
            "Можеш да поискаш прекратяване на sales@jilanov.com. Потвърждаваме крайната дата и евентуална корекция на фактура според приетата оферта и приложимите потребителски права. Този сайт не събира автоматично картови плащания.",
            "От Настройки можеш да изнесеш данните и да поискаш закриване на акаунта. Прекратяването на услугата и окончателното изтриване на данни са отделни заявки; помагаме за уреждането на активно управление на инвертора преди приключване на закриването.",
          ],
        },
      ],
    },
    privacy: {
      title: "Поверителността, обяснена ясно.",
      description:
        "Как JILANOVI Ltd обработва данните за акаунта, соларната инсталация, свързването и известията в Solarman и как да упражниш правата си.",
      eyebrow: "ПОЛИТИКА ЗА ПОВЕРИТЕЛНОСТ",
      introduction:
        "JILANOVI Ltd отговаря за личните данни, обработвани в тази услуга Solarman. Пиши на sales@jilanov.com за данните, акаунта или тази политика.",
      sections: [
        {
          id: "data",
          title: "Каква информация обработваме",
          paragraphs: [
            "Данните за акаунта включват имейл, име на пространството, проверочна стойност на паролата, покани, метаданни за браузърните сесии и събития за сигурност. При включени ключове за достъп (passkeys) съхраняваме публичните им ключове, имена и данни за проверките. Не получаваме пръстов отпечатък, лицево сканиране или частния ключ за достъп.",
            "Свързването със SOLARMAN добавя идентификатор на акаунта при доставчика, защитени данни за вход и API, идентификатори на инсталацията и устройството, настройки, отчитания и записи за управление. Избраният профил за планиране може да съдържа координати, посока и мощност на панелите, капацитет на батерията и електрическа тарифа.",
            "Незадължителните известия на телефона изискват браузърен абонамент и записи за доставяне. Незадължителният Telegram канал използва предоставените от теб получател и данни за бота. Кореспонденция, оферти и фактурни данни се обработват при контакт с нас или приемане на платена услуга. Хостингът и мрежовите услуги обработват и технически данни за връзката, например IP адрес.",
          ],
        },
        {
          id: "purposes",
          title: "Защо я използваме",
          paragraphs: [
            "Обработваме необходимото за заявеното пространство: достъп до акаунта, свързване с доставчика, наблюдение, енергийно планиране, разрешени команди, поддръжка, износ и закриване. Правното основание е предприемането на поискани стъпки преди договор и изпълнението на договор за услугата.",
            "Използваме ограничени записи за сигурност и работа на системата за предотвратяване на неразрешен достъп, проверка на проблеми и надеждно възстановяване, въз основа на легитимния интерес да защитаваме услугата и потребителите. Задължителните счетоводни записи се пазят по закон. Незадължителните известия се заявяват от настройките и браузърните разрешения и могат да се изключат. Не използваме отчитанията за реклама, не ги продаваме и не ги публикуваме като клиентски пример без отделно разрешение.",
          ],
        },
        {
          id: "providers",
          title: "Свързани услуги и доставчици",
          paragraphs: [
            "SOLARMAN/IGEN получава заявките за удостоверяване и устройство, необходими за избраното свързване. Заявките за прогноза към Open-Meteo съдържат необходимите координати и геометрия на панелите; не включват паролата за таблото. Тези доставчици обработват информация и според собствените си условия и политики.",
            "Ако включиш проверки за планирани прекъсвания, ЕРМ Запад получава въведения код на обекта за индивидуална проверка. Проверките по район използват публичните публикации. Данните за проверката се съхраняват криптирано в базата; архивът на пространството съдържа само маскираната подсказка. Можеш да изключиш наблюдението. Датите на отсъствие и оценката за необходимото потребление се използват за планиране; незадължителните енергийни наблюдения сравняват собствените ти измервания. Публичното интерактивно демо използва примерни данни и не се свързва с инвертор.",
            "Доставчиците ни на хостинг, криптирани резервни копия (Amazon Web Services) и служебна електронна поща обработват необходимото за тези услуги. При заявени браузърни известия услугата на устройството, например Apple, Google или Mozilla, получава криптираното известие за доставяне. Telegram се използва само ако настроиш този незадължителен канал.",
            "Някои свързани доставчици работят международно и може да обработват данни извън ЕИП. На sales@jilanov.com можеш да поискаш актуалните получатели, места на обработване и приложимата информация за трансфера при твоята конфигурация. Преглеждаме външния достъп и необходимите гаранции преди допускане на търговска клиентска конфигурация; свързването на акаунт не е общо съгласие за несвързано използване.",
          ],
        },
        {
          id: "security",
          title: "Как защитаваме достъпа",
          paragraphs: [
            "Паролите за таблото се проверяват чрез осолена еднопосочна стойност. Данните за свързване и тайните за известия са криптирани при съхранение. Достъпът е отделен по пространства, а чувствителните промени изискват удостоверяване и допълнително потвърждение. След добавен ключ за достъп само паролата не е достатъчна за вход.",
            "Резервните копия са криптирани, а проверките при възстановяване оставят управлението и известията неактивни до преглед. Тези мерки намаляват риска; онлайн услуга не може да обещае абсолютна сигурност. Съобщи за съмнение за проблем с акаунта на sales@jilanov.com.",
          ],
        },
        {
          id: "retention",
          title: "Колко дълго пазим информацията",
          paragraphs: [
            "Пазим акаунта и историята на инсталацията, докато пространството е активно, за да използваш историческите анализи и записите за управление. Можеш да прегледаш и настроиш автоматичното съхранение в Настройки → Данни и поверителност; когато е включено, избраните срокове важат за отчитанията и активността. Без автоматично изчистване историята остава до премахване чрез закриване или друга приложима заявка за изтриване.",
            "Браузърните сесии изтичат след седем дни, освен ако бъдат прекратени по-рано. Поканите и администраторските връзки за възстановяване имат показан срок. Проверочната стойност на запазен ключ за възстановяване остава до използване, подмяна, отмяна или премахване на акаунта.",
            "Окончателното изтриване премахва действащите данни за свързване и записите на пространството след уреждане на активно управление и проверките за защита при възстановяване. Криптираните резервни обекти обикновено подлежат на изтичане след 30 дни; версии и графици на хранилището може да удължат физическото им наличие. Минимални записи за изтриването не позволяват старо резервно копие да възстанови закрит акаунт. Данни, необходими за счетоводство, спорове или друго законово задължение, може да се пазят за съответния законов срок.",
          ],
        },
        {
          id: "choices",
          title: "Твоите избори и права",
          paragraphs: [
            "Можеш да поискаш достъп, корекция, изтриване, ограничаване, възражение или преносимо копие на личните си данни, когато е приложимо. В Настройки има архив и закриване на акаунта. Можеш да изключиш незадължителните известия и да отмениш достъпа за възстановяване. Пиши на sales@jilanov.com за съдействие или упражняване на право; може да се наложи да потвърдим самоличността ти.",
            "Обикновено отговаряме на искане за права до един месец. Ако законът допуска удължаване при сложно искане, го обясняваме. Можеш да подадеш жалба до Комисията за защита на личните данни в България или друг компетентен надзорен орган.",
          ],
          link: {
            text: "Комисия за защита на личните данни",
            url: "https://cpdp.bg/",
          },
        },
        {
          id: "storage",
          title: "Бисквитки и браузърно съхранение",
          paragraphs: [
            "Таблото използва необходима защитена сесийна бисквитка за входа и браузърно съхранение за избрания език. Добавянето на приложението на началния екран и известията използват възможности на браузъра и устройството. Обработчикът на известията не кешира и не повтаря удостоверени страници, отчитания или команди към инвертора.",
            "В момента няма рекламни бисквитки или външни маркетингови анализи. Заявката за демонстрация отваря чернова на имейл; сайтът не изпраща скрито формуляр. При бъдещи незадължителни анализи или маркетинг ще обновим информацията и ще поискаме необходимото съгласие преди включването им.",
          ],
        },
        {
          id: "changes",
          title: "Промени в политиката",
          paragraphs: [
            "Обновяваме политиката при промени в услугата или обработването. Датата на версията е показана по-долу. Съществени промени за активни клиенти се съобщават чрез подходящ канал в акаунта или поддръжката.",
          ],
        },
      ],
    },
    terms: {
      title: "Разбираеми условия за услугата.",
      description:
        "Условия за Solarman от JILANOVI Ltd: достъп, оферти, поддържано управление, наличност, поддръжка, прекратяване и потребителски права.",
      eyebrow: "УСЛОВИЯ ЗА УСЛУГАТА",
      introduction:
        "Тези условия описват платформата Solarman, предоставяна от JILANOVI Ltd. Писмената клиентска оферта определя платения обхват и цена преди приемане на поръчка.",
      sections: [
        {
          id: "provider",
          title: "Кой предоставя услугата",
          paragraphs: [
            "Доставчик е JILANOVI Ltd, ЕИК 205509804, ДДС номер BG205509804, кв. Левски Г, бл. 4Е, ап. 170, София, България. Представител: Nikolai Jilanov. Контакт за услугата и жалби: sales@jilanov.com.",
            "Това е независимо управлявана платформа, свързана със SOLARMAN OpenAPI. Тя не е приложението Smart или Business на производителя SOLARMAN и не заменя доставчика или монтажника на инвертора.",
          ],
        },
        {
          id: "agreement",
          title: "Демонстрации, достъп и платени поръчки",
          paragraphs: [
            "Заявката за демонстрация или поканата не създават задължение за плащане. Достъпът в момента е с покана. Преди платена услуга изпращаме писмена оферта с функциите, поддържаната инсталация, настройката, общата цена с приложимите данъци, срока, плащането, подновяването и прекратяването. Поръчката се приема писмено; фактурираме според приетата оферта.",
            "Сайтът не събира картови данни, не таксува автоматично демонстрация и не я превръща скрито в абонамент. Офертата не може да отменя задължителни потребителски права. Съществена промяна в платения обхват или цената се съгласува преди да стане дължима.",
          ],
        },
        {
          id: "account",
          title: "Твоят акаунт и инсталация",
          paragraphs: [
            "Предоставяй точни данни за инсталацията и тарифата, използвай акаунт и оборудване, до които имаш право на достъп, и пази данните си за вход и възстановяване. Въвеждай SOLARMAN данни само в защитените настройки. Не изпращай пароли или ключове за възстановяване по имейл.",
            "Носиш отговорност за физическата инсталация, подходящите електрически защити и настройките на инвертора, които разрешаваш. Съвместимостта за наблюдение не означава поддръжка на команди. Управлението се проверява отделно за всяко пространство, включително API капацитетът и доказателствата от изпитване.",
          ],
        },
        {
          id: "controls",
          title: "Ограничения на наблюдението и управлението",
          paragraphs: [
            "Наблюдението използва облачни отчитания, които може да са закъснели, непълни или недостъпни. Зареждането и резервът изискват конкретно поддържан и изпитан профил. Приета заявка не доказва физическия резултат; проверените и непотвърдените резултати се показват отделно.",
            "Командите може да пристигнат със закъснение или да са недостъпни при проблем с интернет или доставчика. Настроен график за зареждане или резерв може да остане активен, докато услугата няма връзка. Запази достъпа до приложението и местните контроли на инвертора и следвай описаните инструкции за възстановяване при нужда.",
            "Платформата не доставя физическо резервно оборудване, не гарантира захранване при прекъсване и не заменя защитите на инвертора и батерията. Прогнозите за времето, потреблението, зареждането и икономиите са оценки според наличните входни данни. Не се обещават фиксирана икономия, непрекъснато захранване или незабавен облачен отговор.",
          ],
        },
        {
          id: "support",
          title: "Поддръжка и наличност",
          paragraphs: [
            "Поддръжката е на sales@jilanov.com, понеделник–петък 09:00–18:00 по софийско време, без официалните празници в България, с първи отговор до следващия работен ден. Срокът за решаване зависи от проблема и достъпа до съответното оборудване или доставчик. Това не е аварийна или електроремонтна услуга.",
            "Работата зависи от хостинг, интернет, достъп и квоти на SOLARMAN, фърмуер и незадължителни доставчици на прогнози и известия. Възможно е време за поддръжка или проверка на проблем; съобщаваме съществени прекъсвания, когато е практически възможно. Допълнително обещание за наличност възниква само при отделно писмено договорено ниво на услуга.",
          ],
        },
        {
          id: "cancellation",
          title: "Прекратяване, отказ и жалби",
          paragraphs: [
            "Поискай прекратяване или подай оплакване на sales@jilanov.com. Потвърждаваме крайната дата, достъпа и евентуална корекция на фактура според приетата оферта и задължителното право. Можеш да изнесеш данните преди заявка за окончателно изтриване. Закриването може да изисква потвърждение, че активно управление на инвертора е безопасно уредено.",
            "Ако си потребител и сключиш договор за услуга от разстояние, по правило имаш 14 дни от сключването за отказ. Изпрати ясно заявление по имейл с име, акаунт, дата на договора и услугата. Не е задължителен специален формуляр. Ако изрично поискаш услугата да започне в този период, приложимото пропорционално плащане и условията за отказ ще бъдат обяснени преди съгласие. Само заявката за демонстрация или активирането на пространство не отменят тези права.",
            "Възстановяванията на суми, средствата за защита при несъответствие и споровете се уреждат според приложимото задължително право. Можеш да потърсиш съдействие от Комисията за защита на потребителите. Тези условия не изключват права или отговорност, които законът не допуска да бъдат изключени.",
          ],
          link: {
            text: "Комисия за защита на потребителите",
            url: "https://kzp.bg/",
          },
        },
        {
          id: "data",
          title: "Данни и допустимо използване",
          paragraphs: [
            "Политиката за поверителност описва обработването, доставчиците, съхранението, износа и изтриването на данни. Не опитвай неразрешен достъп, намеса в друго пространство, заобикаляне на защити или управление на оборудване без разрешение.",
            "Можем да ограничим достъпа, когато е необходимо заради злоупотреба, проблем със сигурността, неуредено плащане по приета оферта или проблем с инсталацията и управлението. Запазваме подходящ достъп до поддръжка, възстановяване и права върху данни и съобщаваме причината, когато е законно и практически възможно. Спирането на достъпа не е доказателство, че физическа настройка на инвертора е премахната.",
          ],
        },
        {
          id: "law",
          title: "Приложимо право и промени",
          paragraphs: [
            "Прилага се българското право при запазване на задължителната защита за потребители в държавата на обичайно пребиваване и приложимите правила за компетентност. Можеш първо да използваш посочения контакт за жалби; това не ограничава правото ти да потърсиш друго средство за защита.",
            "Датата на версията е показана по-долу. Съществени промени по платен договор се съобщават преди влизането им в сила и се уреждат според договора и приложимото право.",
          ],
        },
      ],
    },
  },
};
