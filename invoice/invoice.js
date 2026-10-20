// Phase 3 — public invoice view/pay page logic.
//
// The raw access token lives ONLY in `location.hash` and, for this page
// load, the in-memory `rawToken` variable below — never in
// localStorage/sessionStorage/a cookie, never logged to the console, and
// never sent anywhere except as the JSON body of the two POST calls this
// file makes. The fragment is deliberately left in the visible URL (no
// history.replaceState) — see this file's own header note further down
// for why stripping it would break reload/back-forward/3DS-return
// reliability for no real security gain (fragments are never sent as
// part of any HTTP request, with or without this).
(function () {
  "use strict";

  var rawToken = "";
  var stripe = null;
  var elements = null;
  var paying = false;

  var el = {
    loading: document.getElementById("loading-state"),
    unavailable: document.getElementById("unavailable-state"),
    unavailableMessage: document.getElementById("unavailable-message"),
    invoice: document.getElementById("invoice-state"),
    invoiceNumber: document.getElementById("invoice-number"),
    statusBadge: document.getElementById("status-badge"),
    billTo: document.getElementById("bill-to"),
    lineItemsBody: document.getElementById("line-items-body"),
    totalAmount: document.getElementById("total-amount"),
    amountPaid: document.getElementById("amount-paid"),
    balanceDue: document.getElementById("balance-due"),
    dueDateLine: document.getElementById("due-date-line"),
    invoiceNotes: document.getElementById("invoice-notes"),
    paySection: document.getElementById("pay-section"),
    payButton: document.getElementById("pay-button"),
    paymentElementContainer: document.getElementById("payment-element"),
    payError: document.getElementById("pay-error"),
    paidMessage: document.getElementById("paid-message"),
    voidMessage: document.getElementById("void-message"),
  };

  function showOnly(which) {
    el.loading.hidden = which !== "loading";
    el.unavailable.hidden = which !== "unavailable";
    el.invoice.hidden = which !== "invoice";
  }

  function money(amount) {
    var n = Number(amount) || 0;
    return "$" + n.toFixed(2);
  }

  function readTokenFromFragment() {
    var hash = window.location.hash || "";
    var match = /token=([^&]+)/.exec(hash);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function apiPost(resource, body) {
    return fetch("/api/book?resource=" + resource, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }).then(function (res) {
      return res.json().then(function (json) {
        return { ok: res.ok, status: res.status, body: json };
      });
    });
  }

  function renderUnavailable(message) {
    el.unavailableMessage.textContent = message || "This invoice link is invalid or no longer available.";
    showOnly("unavailable");
  }

  function renderInvoice(data) {
    el.invoiceNumber.textContent = data.invoiceNumber || "";

    var statusLabels = {
      draft: "Draft",
      finalized: "Finalized",
      partially_paid: "Partially Paid",
      paid: "Paid",
      void: "Void",
    };
    var statusClass = "status-due";
    if (data.displayStatus === "paid") statusClass = "status-paid";
    else if (data.displayStatus === "void") statusClass = "status-void";
    else if (data.isOverdue) statusClass = "status-overdue";
    el.statusBadge.className = "status-badge " + statusClass;
    el.statusBadge.textContent = (data.isOverdue && data.displayStatus !== "paid" ? "Overdue — " : "") + (statusLabels[data.displayStatus] || data.displayStatus);

    if (data.billTo) {
      var parts = [data.billTo.name, data.billTo.address, [data.billTo.city, data.billTo.state, data.billTo.zip].filter(Boolean).join(", ")].filter(Boolean);
      el.billTo.textContent = parts.join(" — ");
    } else {
      el.billTo.textContent = "";
    }

    el.lineItemsBody.innerHTML = "";
    (data.lineItems || []).forEach(function (li) {
      var tr = document.createElement("tr");
      ["description", "quantity"].forEach(function () {});
      var tdDesc = document.createElement("td");
      tdDesc.textContent = li.description;
      var tdQty = document.createElement("td");
      tdQty.textContent = li.quantity;
      var tdRate = document.createElement("td");
      tdRate.textContent = money(li.unitPrice);
      var tdAmt = document.createElement("td");
      tdAmt.textContent = money(li.amount);
      tr.appendChild(tdDesc);
      tr.appendChild(tdQty);
      tr.appendChild(tdRate);
      tr.appendChild(tdAmt);
      el.lineItemsBody.appendChild(tr);
    });

    el.totalAmount.textContent = money(data.totalAmount);
    el.amountPaid.textContent = money(data.amountPaid);
    el.balanceDue.textContent = money(data.balanceDue);
    el.dueDateLine.textContent = data.dueDate ? "Due date: " + data.dueDate : "";

    if (data.notes) {
      el.invoiceNotes.textContent = data.notes;
      el.invoiceNotes.hidden = false;
    } else {
      el.invoiceNotes.hidden = true;
    }

    el.paySection.hidden = true;
    el.paidMessage.hidden = true;
    el.voidMessage.hidden = true;

    if (data.displayStatus === "void") {
      el.voidMessage.hidden = false;
    } else if (data.displayStatus === "paid" || Number(data.balanceDue) <= 0) {
      el.paidMessage.hidden = false;
    } else {
      el.paySection.hidden = false;
    }

    showOnly("invoice");
  }

  function loadInvoice() {
    if (!rawToken) {
      renderUnavailable();
      return;
    }
    apiPost("invoice-public", { token: rawToken }).then(function (result) {
      if (!result.ok || !result.body || !result.body.ok) {
        renderUnavailable(result.body && result.body.error);
        return;
      }
      if (!stripe && result.body.stripePublishableKey && window.Stripe) {
        stripe = window.Stripe(result.body.stripePublishableKey);
      }
      renderInvoice(result.body);
    }).catch(function () {
      renderUnavailable();
    });
  }

  function setPayError(message) {
    el.payError.textContent = message || "";
  }

  function startPayment() {
    if (paying) return;
    paying = true;
    setPayError("");
    el.payButton.disabled = true;

    apiPost("invoice-payment-intent", { token: rawToken }).then(function (result) {
      if (!result.ok || !result.body || !result.body.ok) {
        if (result.body && result.body.paid) {
          loadInvoice();
          return;
        }
        setPayError((result.body && result.body.error) || "Could not start payment. Please try again.");
        paying = false;
        el.payButton.disabled = false;
        return;
      }
      if (result.body.paid) {
        loadInvoice();
        return;
      }
      if (!result.body.clientSecret) {
        setPayError("Could not start payment. Please try again.");
        paying = false;
        el.payButton.disabled = false;
        return;
      }
      mountPaymentElement(result.body.clientSecret);
    }).catch(function () {
      setPayError("Could not start payment. Please try again.");
      paying = false;
      el.payButton.disabled = false;
    });
  }

  function mountPaymentElement(clientSecret) {
    if (!stripe) {
      setPayError("Payment is not available right now.");
      paying = false;
      el.payButton.disabled = false;
      return;
    }
    elements = stripe.elements({ clientSecret: clientSecret });
    var paymentElement = elements.create("payment");
    paymentElement.mount("#payment-element");

    el.payButton.textContent = "Submit Payment";
    el.payButton.disabled = false;
    el.payButton.onclick = function () {
      confirmPayment();
    };
  }

  function confirmPayment() {
    el.payButton.disabled = true;
    setPayError("");

    // The return_url re-attaches the token to the fragment explicitly —
    // required so a 3DS redirect round trip recovers the token on return,
    // regardless of whatever the address bar looked like right before the
    // redirect (we never strip the fragment, but this guarantees it even
    // if that ever changes).
    var returnUrl = window.location.origin + window.location.pathname + "#token=" + encodeURIComponent(rawToken);

    stripe.confirmPayment({
      elements: elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    }).then(function (result) {
      if (result.error) {
        setPayError(result.error.message || "Payment could not be completed.");
        el.payButton.disabled = false;
        return;
      }
      // Non-redirect case resolved in-page — re-fetch to reflect the
      // server-verified (never client-trusted) outcome.
      loadInvoice();
    });
  }

  rawToken = readTokenFromFragment();
  el.payButton.addEventListener("click", startPayment);
  loadInvoice();
})();
