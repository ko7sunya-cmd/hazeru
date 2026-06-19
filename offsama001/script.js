// script.js
const observer = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) {
    // データ属性から次のページのURLを取得する
    const nextUrl = document.body.getAttribute('data-next');
    if (nextUrl) {
      setTimeout(() => {
        window.location.href = nextUrl;
      }, 500);
    }
  }
});

// ページの一番下に「次へのトリガー」があれば監視する
const trigger = document.querySelector("#next-trigger");
if (trigger) {
  observer.observe(trigger);
}