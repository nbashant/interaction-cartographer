import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Step = "product" | "shipping" | "payment" | "confirmation";

function App() {
  const [cartOpen, setCartOpen] = useState(false);
  const [step, setStep] = useState<Step>("product");
  const [promoError, setPromoError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [continueDisabled, setContinueDisabled] = useState(false);

  async function applyPromo() {
    setPromoError("");
    const response = await fetch("/api/promo", { method: "POST", body: JSON.stringify({ code: "BROKEN500" }) });
    if (!response.ok) {
      setPromoError("Promo service unavailable.");
    }
  }

  function continueShipping() {
    setValidationError("Shipping address needs a city before continuing.");
    setContinueDisabled(true);
  }

  return (
    <div className="checkout-shell">
      <header className="shop-header">
        <strong>Mini Checkout</strong>
        <nav aria-label="Checkout steps">
          <button data-cartograph="nav-product" className={step === "product" ? "active" : ""} onClick={() => setStep("product")}>Product</button>
          <button data-cartograph="nav-shipping" className={step === "shipping" ? "active" : ""} onClick={() => setStep("shipping")}>Shipping</button>
          <button data-cartograph="nav-payment" className={step === "payment" ? "active" : ""} onClick={() => setStep("payment")}>Payment</button>
        </nav>
        <button data-cartograph="open-cart" className="cart-button" onClick={() => setCartOpen(true)}>Cart</button>
      </header>

      <main data-cartograph-main className="checkout-main">
        {step === "product" ? <Product setCartOpen={setCartOpen} /> : null}
        {step === "shipping" ? (
          <Shipping
            applyPromo={applyPromo}
            promoError={promoError}
            continueShipping={continueShipping}
            validationError={validationError}
            continueDisabled={continueDisabled}
          />
        ) : null}
        {step === "payment" ? <Payment setStep={setStep} /> : null}
        {step === "confirmation" ? <Confirmation /> : null}
      </main>

      {cartOpen ? <CartDrawer setCartOpen={setCartOpen} setStep={setStep} /> : null}
    </div>
  );
}

function Product({ setCartOpen }: { setCartOpen: (open: boolean) => void }) {
  return (
    <section className="product-view">
      <div className="product-art" aria-hidden="true">
        <span />
      </div>
      <div className="product-copy">
        <h1>Field Kit Pro</h1>
        <p>Compact gear kit for teams that ship from everywhere.</p>
        <strong>$128</strong>
        <div className="action-row">
          <button data-cartograph="add-to-cart" className="primary" onClick={() => setCartOpen(true)}>Add to cart</button>
          <button data-cartograph="product-details">Product details</button>
        </div>
      </div>
    </section>
  );
}

function CartDrawer({ setCartOpen, setStep }: { setCartOpen: (open: boolean) => void; setStep: (step: Step) => void }) {
  return (
    <aside className="cart-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-title">
      <div className="drawer-heading">
        <h2 id="cart-title">Cart drawer</h2>
        <button data-cartograph="close-cart" onClick={() => setCartOpen(false)}>Close</button>
      </div>
      <div className="cart-line">
        <span>Field Kit Pro</span>
        <strong>$128</strong>
      </div>
      <p className="drawer-note">Focus trap is intentionally incomplete in this demo fixture.</p>
      <button
        data-cartograph="checkout-from-cart"
        className="primary"
        onClick={() => {
          setCartOpen(false);
          setStep("shipping");
        }}
      >
        Checkout
      </button>
    </aside>
  );
}

function Shipping({
  applyPromo,
  promoError,
  continueShipping,
  validationError,
  continueDisabled
}: {
  applyPromo: () => void;
  promoError: string;
  continueShipping: () => void;
  validationError: string;
  continueDisabled: boolean;
}) {
  return (
    <section className="checkout-card">
      <div className="section-title">
        <h1>Checkout form</h1>
        <span>Shipping method</span>
      </div>
      <form>
        <label>
          Full name
          <input data-cartograph="shipping-name" placeholder="Ada Cartographer" />
        </label>
        <label>
          Address line
          <input data-cartograph="shipping-address" placeholder="135 Market Street" />
        </label>
        <label>
          City
          <input data-cartograph="shipping-city" placeholder="San Francisco" />
        </label>
      </form>
      <div className="address-preview">
        135 Market Street, Suite 1200, San Francisco, California 94105, United States of America
      </div>
      <div className="promo-row">
        <label>
          Promo code
          <input data-cartograph="promo-code" placeholder="BROKEN500" />
        </label>
        <button data-cartograph="apply-promo" type="button" onClick={applyPromo}>Apply promo</button>
      </div>
      {promoError ? <p className="error-text" role="alert">{promoError}</p> : null}
      {validationError ? <p className="error-text" role="alert">{validationError}</p> : null}
      <button data-cartograph="continue-shipping" type="button" className="primary" disabled={continueDisabled} onClick={continueShipping}>
        Continue to payment
      </button>
    </section>
  );
}

function Payment({ setStep }: { setStep: (step: Step) => void }) {
  return (
    <section className="checkout-card payment-step">
      <div className="section-title">
        <h1>Payment step</h1>
        <span>Hidden on mobile by design bug</span>
      </div>
      <label>
        Card number
        <input data-cartograph="card-number" placeholder="4242 4242 4242 4242" />
      </label>
      <button data-cartograph="place-order" className="primary" onClick={() => setStep("confirmation")}>Place order</button>
    </section>
  );
}

function Confirmation() {
  return (
    <section className="checkout-card">
      <h1>Confirmation</h1>
      <p>Order ready for local pickup.</p>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
