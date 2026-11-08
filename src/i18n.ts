import { useEffect, useState } from "react";

const en = {
  appName: "Mixes Order",
  chooseStore: "Choose your store",
  searchStore: "Search store…",
  pin: "Store PIN",
  pinHelp: "4-digit PIN from your manager",
  continue: "Continue",
  orderFor: "Order for",
  closesIn: "Closes in",
  closesAt: "Order closes at",
  closed: "This order is closed",
  closedHelp: "The cutoff has passed. The next order day is now open.",
  last: "Last",
  copyLast: "Copy last order",
  clear: "Clear",
  submit: "Submit order",
  update: "Update order",
  saving: "Saving…",
  submittedAt: "Submitted at",
  canChange: "You can change it until the cutoff.",
  notSubmitted: "Not submitted yet",
  carriedNote: "If you don't submit before the cutoff, yesterday's order is copied automatically.",
  calculated: "Calculated automatically",
  fillAll: "Enter a quantity for every item (use 0 if you need none).",
  switchStore: "Switch store",
  saved: "Order saved",
  reload: "Load the new order",
  lang: "العربية",
  noStores: "No stores yet. Ask the admin to set up the store list.",
  hours: "h",
  minutes: "m",
  admin: "Admin",
  confirmHigh: "These quantities are much higher than your last order. Submit anyway?",
};

type Dict = typeof en;

const ar: Dict = {
  appName: "طلب الخلطات",
  chooseStore: "اختر الفرع",
  searchStore: "ابحث عن الفرع…",
  pin: "رمز الفرع",
  pinHelp: "رمز من ٤ أرقام من مديرك",
  continue: "متابعة",
  orderFor: "طلب يوم",
  closesIn: "يغلق خلال",
  closesAt: "يغلق الطلب الساعة",
  closed: "تم إغلاق هذا الطلب",
  closedHelp: "انتهى وقت الطلب. تم فتح طلب اليوم التالي.",
  last: "السابق",
  copyLast: "نسخ الطلب السابق",
  clear: "مسح",
  submit: "إرسال الطلب",
  update: "تحديث الطلب",
  saving: "جارٍ الحفظ…",
  submittedAt: "تم الإرسال الساعة",
  canChange: "يمكنك التعديل حتى وقت الإغلاق.",
  notSubmitted: "لم يتم الإرسال بعد",
  carriedNote: "إذا لم ترسل الطلب قبل وقت الإغلاق، سيتم نسخ طلب الأمس تلقائياً.",
  calculated: "يُحسب تلقائياً",
  fillAll: "أدخل كمية لكل صنف (اكتب ٠ إذا لا تحتاج).",
  switchStore: "تغيير الفرع",
  saved: "تم حفظ الطلب",
  reload: "فتح الطلب الجديد",
  lang: "English",
  noStores: "لا توجد فروع بعد. اطلب من المسؤول إضافة الفروع.",
  hours: "س",
  minutes: "د",
  admin: "المسؤول",
  confirmHigh: "هذه الكميات أعلى بكثير من طلبك السابق. هل تريد الإرسال؟",
};

export type Lang = "en" | "ar";

export const strings = (lang: Lang): Dict => (lang === "ar" ? ar : en);

function readLang(): Lang {
  try {
    return localStorage.getItem("hm_lang") === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

export function useLang() {
  const [lang, setLang] = useState<Lang>(readLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    try {
      localStorage.setItem("hm_lang", lang);
    } catch {
      /* private mode */
    }
  }, [lang]);
  return { lang, t: strings(lang), toggle: () => setLang((l) => (l === "ar" ? "en" : "ar")) };
}
