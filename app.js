(() => {
  "use strict";

  const CFG = {
    rnbOgc: "https://rnb-api.beta.gouv.fr/api/alpha/ogc/collections/buildings/items",
    rnbBuilding: "https://rnb-api.beta.gouv.fr/api/alpha/buildings",
    rnbAddress: "https://rnb-api.beta.gouv.fr/api/alpha/buildings/address/",
    bdnbBase: "https://api.bdnb.io/v1/bdnb",
    cadastreApi: "https://apicarto.ign.fr/api/cadastre/parcelle",
    dvfApiBases: [
      "https://apidf.k8-dev.cerema.fr",
      "https://apidf-preprod.cerema.fr"
    ],
    sitadelDatafile: "8b35affb-55fc-4c1f-915b-7750f974446a",
    didoBase: "https://data.statistiques.developpement-durable.gouv.fr/dido/api/v1/datafiles",
    minZoom: 16
  };

  const $ = s => document.querySelector(s);
  const state = {
    geoLayer: null,
    selectedRnbId: null,
    selectedFeature: null,
    metadata: null,
    loadTimer: null,
    currentBdnb: null,
    currentEnvelope: null,
    bdnbInflight: new Map(),
    bdnbCacheMinutes: 60,
    parcels: [],
    parcelLayer: null,
    dvf: [],
    dvfLoadedFor: null,
    sitadel: [],
    sitadelLoadedFor: null,
    apiStatus: {
      rnb: { state: "pending", label: "En attente" },
      bdnb: { state: "pending", label: "En attente" },
      cadastre: { state: "pending", label: "En attente" },
      dvf: { state: "pending", label: "En attente" },
      sitadel: { state: "pending", label: "En attente" },
    }
  };

  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    maxBounds: [[48.63, .7], [49.37, 3.35]]
  }).setView([49.07, 2.12], 10);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    crossOrigin: true,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);

  const parcelLegend = document.createElement("div");
  parcelLegend.className = "map-parcel-legend";
  parcelLegend.innerHTML = '<span class="map-parcel-swatch"></span> Parcelle(s) du bâtiment';
  parcelLegend.style.display = "none";
  document.querySelector(".map-card").appendChild(parcelLegend);

  const InfoControl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd() {
      const container = L.DomUtil.create("div", "leaflet-bar info-control");
      const link = L.DomUtil.create("a", "", container);
      link.href = "#";
      link.title = "À propos";
      link.setAttribute("aria-label", "À propos");
      link.textContent = "i";
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.on(link, "click", event => {
        L.DomEvent.preventDefault(event);
        $("#about-modal").hidden = false;
      });
      return container;
    }
  });
  map.addControl(new InfoControl());

  map.on("tileerror", () => {
    live("ko", "Fond de carte inaccessible", "le réseau bloque OpenStreetMap");
  });

  function setTextSafe(selector, value) {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  }

  function setHtmlSafe(selector, value) {
    const element = document.querySelector(selector);
    if (element) element.innerHTML = value;
  }

  function setApiStatus(source, status, label) {
    state.apiStatus[source] = { state: status, label };
    const row = document.querySelector(`.source-monitor-row[data-source="${source}"]`);
    if (row) {
      row.classList.remove("ok", "warn", "ko", "pending");
      row.classList.add(status);
      const light = row.querySelector(".api-light");
      if (light) {
        light.className = `api-light ${status}`;
      }
      const text = row.querySelector(".api-state");
      if (text) text.textContent = label;
    }
    refreshGlobalApiState();
  }

  function refreshGlobalApiState() {
    const statuses = Object.values(state.apiStatus).map(item => item.state);
    const global = $("#global-api-state");
    if (!global) return;

    global.className = "global-api-state";
    if (statuses.some(status => status === "ko")) {
      global.classList.add("warn");
      global.textContent = "Connexion partielle";
    } else if (statuses.every(status => status === "ok" || status === "warn")) {
      global.classList.add("ok");
      global.textContent = "Services actifs";
    } else {
      global.textContent = "Initialisation";
    }
  }

  function live(kind, text, sub) {
    $("#live-dot").className = "live-dot" + (kind ? ` ${kind}` : "");
    setTextSafe("#live-text", text);
    setTextSafe("#live-sub", sub || "");
    $("#status-line").innerHTML = `<b>RNB + BDNB</b> · ${escapeHtml(text)}${sub ? ` · ${escapeHtml(sub)}` : ""}`;
  }

  function progress(value) {
    $("#progress-bar").style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function getJSON(url, options = {}) {
    const { retries = 0, retryDelay = 900 } = options;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          cache: "no-store",
          mode: "cors",
          headers: { "Accept": "application/json" }
        });
      } catch (error) {
        lastError = new Error(`Connexion impossible : ${error.message}`);
        if (attempt < retries) {
          await sleep(retryDelay * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; }
      catch { data = { raw: text }; }

      if (response.ok) return data;

      const error = new Error(data?.detail || data?.error || `HTTP ${response.status}`);
      error.status = response.status;
      lastError = error;

      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : retryDelay * Math.pow(2, attempt);
        await sleep(wait);
        continue;
      }
      throw error;
    }
    throw lastError || new Error("API indisponible");
  }

  function bdnbCacheKey(rnbId) {
    return `observatoire-bati:bdnb-complet:${rnbId}`;
  }

  function readBdnbCache(rnbId) {
    try {
      const raw = localStorage.getItem(bdnbCacheKey(rnbId));
      if (!raw) return null;
      const cached = JSON.parse(raw);
      const maxAge = state.bdnbCacheMinutes * 60 * 1000;
      if (!cached?.savedAt || Date.now() - cached.savedAt > maxAge) return null;
      return cached.value || null;
    } catch { return null; }
  }

  function writeBdnbCache(rnbId, value) {
    try {
      localStorage.setItem(bdnbCacheKey(rnbId), JSON.stringify({
        savedAt: Date.now(),
        value
      }));
    } catch (error) {
      console.warn("Cache BDNB", error);
    }
  }

  async function loadMetadata() {
    state.metadata = { millesime: "2026-02.a" };
  }

  function featureRnbId(feature) {
    return feature?.id ||
      feature?.properties?.rnb_id ||
      feature?.properties?.id ||
      feature?.properties?.rnbId ||
      null;
  }

  function styleFeature(feature) {
    const selected = featureRnbId(feature) === state.selectedRnbId;
    return {
      color: selected ? "#000091" : "#8d3d1e",
      weight: selected ? 3 : 1,
      fillColor: selected ? "#000091" : "#e77735",
      fillOpacity: selected ? .55 : .34
    };
  }

  function bindFeature(feature, layer) {
    const rnbId = featureRnbId(feature);
    layer.bindTooltip(rnbId ? `ID-RNB · ${rnbId}` : "Bâtiment RNB", {
      sticky: true,
      direction: "top"
    });

    layer.on("click", async event => {
      L.DomEvent.stopPropagation(event);
      state.selectedFeature = feature;
      state.selectedRnbId = rnbId;
      if (state.geoLayer) state.geoLayer.setStyle(styleFeature);
      openLocalBuilding(feature);
      if (rnbId) await loadBdnb(rnbId);
    });
  }

  async function loadVisibleBuildings() {
    clearTimeout(state.loadTimer);

    if (map.getZoom() < CFG.minZoom) {
      if (state.geoLayer) {
        state.geoLayer.remove();
        state.geoLayer = null;
      }
      $("#map-help").style.display = "";
      live("", "Zoomez pour afficher les bâtiments", `niveau ${CFG.minZoom} minimum`);
      return;
    }

    $("#map-help").style.display = "none";
    progress(15);
    live("", "Chargement des bâtiments RNB", "emprise courante");

    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");

    try {
      const collection = await getJSON(`${CFG.rnbOgc}?bbox=${encodeURIComponent(bbox)}&limit=100`);
      setApiStatus("rnb", "ok", "Connecté");
      if (state.geoLayer) state.geoLayer.remove();

      state.geoLayer = L.geoJSON(collection, {
        style: styleFeature,
        pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
          radius: 6, color: "#8d3d1e", fillColor: "#e77735", fillOpacity: .6
        }),
        onEachFeature: bindFeature
      }).addTo(map);

      const count = collection?.features?.length || 0;
      live("ok", `${count} bâtiments chargés`, "cliquez sur une emprise");
      progress(100);
      setTimeout(() => progress(0), 450);
    } catch (error) {
      console.error(error);
      setApiStatus("rnb", "ko", "Indisponible");
      live("ko", "Échec du chargement RNB", error.message);
      progress(0);
    }
  }

  function openLocalBuilding(feature) {
    const p = feature?.properties || {};
    const addresses = Array.isArray(p.addresses) ? p.addresses : [];
    const address = addresses[0] || {};
    const title = formatAddress(address) || "Bâtiment RNB";
    const rnbId = featureRnbId(feature);

    setTextSafe("#drawer-title", title);
    $("#drawer-sub").textContent = rnbId ? `ID-RNB ${rnbId}` : "Identifiant non disponible";
    setTextSafe("#summary-status", "Interrogation de la BDNB");
    setTextSafe("#summary-date", "en cours");
    $("#summary-text").textContent = "La géométrie RNB est chargée. Recherche des données consolidées…";
    $("#drawer-body").innerHTML = renderIdentity(feature) + skeletonBlock();
    $("#drawer").classList.add("open");
    $("#btn-export").disabled = true;
    setApiStatus("cadastre", "pending", "Interrogation");
    setApiStatus("dvf", "pending", "Interrogation");
    setApiStatus("sitadel", "pending", "Interrogation");
    loadCadastreForFeature(feature);
    loadDvfForFeature(feature);
    loadSitadelForFeature(feature);
  }

  async function fetchBdnbByRnb(rnbId) {
    const cached = readBdnbCache(rnbId);
    if (cached) return { ...cached, cache: true };

    if (state.bdnbInflight.has(rnbId)) {
      return state.bdnbInflight.get(rnbId);
    }

    const promise = (async () => {
      // Appel 1 : ID-RNB -> identifiant bâtiment construction.
      const relationParams = new URLSearchParams({
        "rnb_id": `eq.${rnbId}`,
        "select": "rnb_id,batiment_construction_id,type_appariement",
        "limit": "20"
      });

      const relationResponse = await getJSON(
        `${CFG.bdnbBase}/donnees/rel_batiment_construction_rnb?${relationParams}`,
        { retries: 3, retryDelay: 1100 }
      );

      const relationRows = rowsOf(relationResponse);
      const constructionIds = [...new Set(
        relationRows
          .map(row => row?.batiment_construction_id)
          .filter(Boolean)
      )];

      if (!constructionIds.length) {
        throw new Error("Aucune correspondance BDNB trouvée pour cet ID-RNB.");
      }

      // Appel 2 : bâtiment construction -> groupe de bâtiments.
      // Une entrée RNB peut exceptionnellement être liée à plusieurs constructions.
      const constructionFilter = constructionIds.length === 1
        ? `eq.${constructionIds[0]}`
        : `in.(${constructionIds.join(",")})`;

      const constructionParams = new URLSearchParams({
        "batiment_construction_id": constructionFilter,
        "select": "batiment_construction_id,batiment_groupe_id",
        "limit": "50"
      });

      const constructionResponse = await getJSON(
        `${CFG.bdnbBase}/donnees/batiment_construction?${constructionParams}`,
        { retries: 3, retryDelay: 1100 }
      );

      const constructionRows = rowsOf(constructionResponse);
      const groupIds = [...new Set(
        constructionRows
          .map(row => row?.batiment_groupe_id)
          .filter(Boolean)
      )];

      if (!groupIds.length) {
        throw new Error(
          "Le bâtiment RNB est connu de la BDNB, mais aucun groupe de bâtiments n’a été retrouvé."
        );
      }

      // La majorité des associations sont 1 RNB = 1 groupe.
      // En cas de relation complexe, on prend le premier groupe exposé par la BDNB.
      const groupId = groupIds[0];

      // Appel 3 : fiche complète agrégée.
      const completeParams = new URLSearchParams({
        "batiment_groupe_id": `eq.${groupId}`,
        "limit": "1"
      });

      const completeResponse = await getJSON(
        `${CFG.bdnbBase}/donnees/batiment_groupe_complet?${completeParams}`,
        { retries: 3, retryDelay: 1300 }
      );

      const completeRows = rowsOf(completeResponse);
      const record = completeRows[0] || null;

      if (!record) {
        throw new Error(
          "La BDNB a identifié le bâtiment mais n’a renvoyé aucune fiche complète."
        );
      }

      const data = splitCompleteBdnbRecord(record);
      const result = {
        rnb_id: rnbId,
        batiment_construction_ids: constructionIds,
        batiment_groupe_id: groupId,
        batiment_groupe_ids: groupIds,
        millesime: "2026-02.a",
        data,
        complete_record: record,
        partial: groupIds.length > 1
      };

      writeBdnbCache(rnbId, result);
      return result;
    })();

    state.bdnbInflight.set(rnbId, promise);

    try {
      return await promise;
    } finally {
      state.bdnbInflight.delete(rnbId);
    }
  }

  function splitCompleteBdnbRecord(record) {
    const sections = {
      building: {}, address: {}, usage: {}, rpls: {}, dpe: {}, rnc: {},
      risks: {}, bdtopo: {}, renovation: {}, ffo: {}
    };

    const rules = [
      ["rpls", /(rpls|nb_log_loue|nb_log_vac|loyer_moyen|accessible_pmr|dans_qpv|classe_ener_principale|classe_ges_principale|raison_sociale_principal|siret_principal)/i],
      ["dpe", /(dpe|classe_bilan|classe_emission|conso_5_usages|conso_3_usages|deperdition|type_energie_chauffage|type_installation_chauffage|type_ventilation|type_vitrage|isolation|surface_habitable)/i],
      ["rnc", /(rnc|copro|syndic|numero_immat|nb_lot)/i],
      ["risks", /(risque|argile|radon|sismique|incendie|inondation|submersion)/i],
      ["renovation", /(renov|opportunite|contrainte|geother|solaire|pac|favorabilite)/i],
      ["bdtopo", /(bdtopo|hauteur|max_hauteur|l_nature|l_usage)/i],
      ["usage", /(usage|propriete|proprietaire|categorie_usage)/i],
      ["address", /(adresse|ban_|code_postal|numero_voie|nom_voie)/i],
      ["ffo", /(^nb_log$|annee_construction|fichier_foncier|ffo|surface_fiscale|local)/i]
    ];

    for (const [key, value] of Object.entries(record || {})) {
      let assigned = false;
      for (const [section, regex] of rules) {
        if (regex.test(key)) {
          sections[section][key] = value;
          assigned = true;
          break;
        }
      }
      if (!assigned) sections.building[key] = value;
    }

    // Alias attendus par l'interface.
    aliasFirst(sections.rpls, "nb_log", ["nb_log_rpls", "rpls_nb_log", "nombre_logements_rpls"]);
    aliasFirst(sections.rpls, "nb_log_loue", ["rpls_nb_log_loue", "nombre_logements_loues_rpls"]);
    aliasFirst(sections.rpls, "nb_log_vac", ["rpls_nb_log_vac", "nombre_logements_vacants_rpls"]);
    aliasFirst(sections.rpls, "dans_qpv", ["rpls_dans_qpv", "dans_qp"]);
    aliasFirst(sections.dpe, "classe_bilan_dpe", ["classe_bilan_dpe", "dpe_classe_bilan", "classe_dpe", "etiquette_dpe"]);
    aliasFirst(sections.dpe, "classe_emission_ges", ["classe_emission_ges", "dpe_classe_ges", "classe_ges", "etiquette_ges"]);
    aliasFirst(sections.dpe, "date_etablissement_dpe", ["date_etablissement_dpe", "dpe_date_etablissement", "date_dpe"]);
    aliasFirst(sections.ffo, "nb_log", ["nb_log", "nombre_logements"]);

    return sections;
  }

  function aliasFirst(target, canonical, candidates) {
    if (target[canonical] !== undefined && target[canonical] !== null && target[canonical] !== "") return;
    const entries = Object.entries(target);
    for (const candidate of candidates) {
      const exact = entries.find(([key, value]) =>
        normalizeKeyName(key) === normalizeKeyName(candidate) &&
        value !== null && value !== undefined && value !== ""
      );
      if (exact) {
        target[canonical] = exact[1];
        return;
      }
    }
  }

  function rowsOf(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.results)) return value.results;
    return [];
  }

  async function loadBdnb(rnbId) {
    progress(25);
    live("", "Interrogation de la BDNB", rnbId);

    try {
      const result = await fetchBdnbByRnb(rnbId);
      setApiStatus("bdnb", "ok", result?.cache ? "Cache local" : "Connecté");
      const record = result?.data || result?.record || result;
      renderBdnb(record, result);
      live("ok", "Fiche bâtiment actualisée", result?.cache ? "cache BDNB" : "API BDNB");
      progress(100);
      setTimeout(() => progress(0), 450);
    } catch (error) {
      console.error(error);
      setApiStatus(
        "bdnb",
        error?.status === 429 ? "warn" : "ko",
        error?.status === 429 ? "API très sollicitée" : "Indisponible"
      );
      setTextSafe("#summary-status", "Données complémentaires indisponibles");
      $("#btn-export").disabled = true;
      $("#summary-date").textContent = new Date().toLocaleTimeString("fr-FR", {hour:"2-digit", minute:"2-digit"});
      setTextSafe(
        "#summary-text",
        error?.status === 429
          ? "La BDNB est momentanément très sollicitée. La fiche sera réessayée automatiquement au prochain clic."
          : "Les données complémentaires ne sont pas accessibles pour le moment. L’identité RNB et les informations cadastrales restent disponibles."
      );
      const drawerBody = document.querySelector("#drawer-body");
      if (drawerBody) {
        const existingLoading = drawerBody.querySelector(".bdnb-loading-block");
        if (existingLoading) existingLoading.remove();
        drawerBody.insertAdjacentHTML(
          "beforeend",
          `<div class="block">
            <div class="block-title">Données complémentaires momentanément indisponibles</div>
            <div class="notice">
              La fiche conserve les informations RNB et cadastrales. Réessayez ultérieurement pour le DPE, le RPLS, la copropriété et les risques.
            </div>
          </div>`
        );
      }
      live("ko", "BDNB momentanément indisponible", "les autres sources restent actives");
      progress(0);
    }
  }

  function normalizeBoolean(value) {
    if (value === true) return true;
    if (value === false) return false;
    const text = String(value ?? "").trim().toLowerCase();
    if (["oui", "yes", "true", "1", "o"].includes(text)) return true;
    if (["non", "no", "false", "0", "n"].includes(text)) return false;
    return null;
  }

  function renderBdnb(data, envelope) {
    state.currentBdnb = data;
    state.currentEnvelope = envelope;
    $("#btn-export").disabled = false;
    const dpe = data?.dpe || {};
    const rpls = data?.rpls || {};
    const usage = data?.usage || {};

    const qpvRaw =
      rpls.dans_qpv ??
      rpls.dans_qp ??
      rpls.qpv ??
      data?.building?.dans_qpv ??
      data?.ffo?.dans_qpv ??
      null;

    const isInQpv = normalizeBoolean(qpvRaw);
    const rnc = data?.rnc || {};
    const risks = data?.risks || {};
    const bdtopo = data?.bdtopo || {};
    const renovation = data?.renovation || {};
    const building = data?.building || {};
    const ffo = data?.ffo || {};

    const dpeClass =
      dpe.classe_bilan_dpe ||
      dpe.classe_conso_energie_arrete_2012 ||
      null;
    const gesClass =
      dpe.classe_emission_ges ||
      dpe.classe_emission_ges_arrete_2012 ||
      null;
    const dpeConsumption =
      dpe.conso_5_usages_ep_m2 ??
      dpe.conso_3_usages_ep_m2_arrete_2012 ??
      null;
    const dpeDate =
      dpe.date_etablissement_dpe ||
      dpe.date_reception_dpe ||
      null;

    const rplsCount = rpls.nb_log ?? null;
    const rplsVintage = "2024";
    const bdnbVintage = envelope?.millesime || "2026-02.a";

    const hasData = Object.values(data || {}).some(Boolean);
    $("#summary-status").textContent =
      hasData ? "Fiche bâtiment disponible" : "Données limitées";
    $("#summary-date").textContent = `BDNB ${bdnbVintage}`;
    $("#summary-text").textContent =
      "Les informations sont interrogées directement dans les tables métier de la BDNB.";

    const isSocialHousing = Number(rplsCount) > 0;
    const rplsHtml = isSocialHousing
      ? `<div class="block rpls-block">
          <div class="block-title-row"><div><div class="block-title">Parc locatif social</div></div><div class="block-icon">SOC</div></div>
          <div class="social-status yes">
            <div><div class="label">Bâtiment relevant du parc social</div><div class="detail">RPLS ${rplsVintage}</div></div>
            <div class="value">Oui</div>
          </div>
          <div class="section-intro">Données agrégées au bâtiment · millésime RPLS ${rplsVintage}</div>
          <div class="metrics">
            ${metric("Logements sociaux", rpls.nb_log)}
            ${metric("Logements loués", rpls.nb_log_loue)}
            ${metric("Logements vacants", rpls.nb_log_vac)}
          </div>
          <div class="data-grid" style="margin-top:8px">
            ${dataRow("Bailleur principal", rpls.raison_sociale_principal)}
            ${dataRow("SIRET du bailleur", rpls.siret_principal)}
            ${dataRow("Loyer moyen", rpls.loyer_moyen != null ? `${rpls.loyer_moyen} €` : null)}
            ${dataRow("Loyer moyen au m²", rpls.loyer_moyen_m2 != null ? `${rpls.loyer_moyen_m2} €/m²` : null)}
            ${dataRow("Type de construction", formatList(rpls.type_construction))}
            ${dataRow("Accessible PMR", yesNo(rpls.accessible_pmr))}
            ${dataRow("Situé en QPV", yesNo(rpls.dans_qpv))}
            ${dataRow("Classe énergie principale RPLS", rpls.classe_ener_principale)}
            ${dataRow("Classe GES principale RPLS", rpls.classe_ges_principale)}
          </div>
          <div class="source-line">
            <span class="source-tag">Source RPLS ${rplsVintage}</span>
            <span class="source-tag">Agrégation BDNB</span>
          </div>
        </div>`
      : `<div class="block rpls-block">
          <div class="block-title-row"><div class="block-title">Parc locatif social</div><div class="block-icon">SOC</div></div>
          <div class="social-status no">
            <div><div class="label">Bâtiment relevant du parc social</div><div class="detail">Aucun logement RPLS rattaché · millésime ${rplsVintage}</div></div>
            <div class="value">Non</div>
          </div>
          <div class="notice">Aucun logement social n’est rattaché à ce bâtiment dans la BDNB pour le millésime RPLS ${rplsVintage}. Cette information est présentée comme <strong>Non</strong> afin d’éviter toute ambiguïté pour l’utilisateur.</div>
        </div>`;

    const dpeHtml = dpeClass
      ? `<div class="block dpe-block">
          <div class="block-title-row"><div><div class="block-title">Performance énergétique</div></div><div class="block-icon">DPE</div></div>
          <div class="section-intro">DPE représentatif retenu par la BDNB pour ce bâtiment</div>
          <div class="metrics">
            ${metric("Classe DPE", dpeClass)}
            ${metric("Classe GES", gesClass)}
            ${metric("Consommation", dpeConsumption, dpeConsumption != null ? "kWhEP/m²/an" : "")}
          </div>
          <div class="data-grid" style="margin-top:8px">
            ${dataRow("Date du diagnostic", dpeDate ? formatDate(dpeDate) : null)}
            ${dataRow("Identifiant DPE", dpe.identifiant_dpe)}
            ${dataRow("DPE nouvelle méthode", yesNo(dpe.arrete_2021))}
            ${dataRow("Type de bâtiment", dpe.type_batiment_dpe)}
            ${dataRow("Année de construction", dpe.annee_construction_dpe)}
            ${dataRow("Surface habitable", dpe.surface_habitable_immeuble || dpe.surface_habitable_logement)}
            ${dataRow("Énergie de chauffage", dpe.type_energie_chauffage)}
            ${dataRow("Installation de chauffage", dpe.type_installation_chauffage)}
            ${dataRow("Ventilation", dpe.type_ventilation)}
            ${dataRow("Vitrage", dpe.type_vitrage)}
            ${dataRow("Isolation des murs", dpe.type_isolation_mur_exterieur)}
            ${dataRow("Production renouvelable", dpe.type_production_energie_renouvelable)}
          </div>
          <div class="source-line">
            <span class="source-tag">DPE ADEME</span>
            <span class="source-tag">DPE représentatif BDNB</span>
          </div>
        </div>`
      : `<div class="block dpe-block">
          <div class="block-title-row"><div><div class="block-title">Performance énergétique</div></div><div class="block-icon">DPE</div></div>
          <div class="notice"><strong>Aucun DPE représentatif disponible.</strong><br>
          La BDNB ne rattache pas de diagnostic exploitable à ce bâtiment.</div>
        </div>`;

    const generalRows = [
      ["Usage principal", usage.usage_principal_bdnb_open],
      ["Catégorie d’usage et propriété", usage.categorie_usage_propriete],
      ["Année de construction", building.annee_construction || ffo.annee_construction],
      ["Nombre total de logements", ffo.nb_log],
      ["Nombre de niveaux", bdtopo.max_hauteur ? null : building.nb_niveau],
      ["Hauteur maximale", bdtopo.max_hauteur != null ? `${bdtopo.max_hauteur} m` : null],
      ["Nature BD TOPO", formatList(bdtopo.l_nature)],
      ["Usage BD TOPO", formatList(bdtopo.l_usage_1)]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");

    const coproRows = [
      ["Immatriculation RNC", rnc.numero_immat],
      ["Nombre de lots", rnc.nb_lot_tot],
      ["Lots d’habitation", rnc.nb_lot_hab],
      ["Syndic", rnc.syndic_nom],
      ["Copropriété fragile", yesNoNullable(rnc.copro_dans_pvd)]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");

    const risksRows = [
      ["Aléa argile", risks.argile_alea],
      ["Potentiel radon", risks.radon_niveau],
      ["Zone sismique", risks.sismique_niveau],
      ["Famille incendie", risks.classe_risque_incendie]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");

    const renovationRows = Object.entries(renovation || {})
      .filter(([key, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        key !== "batiment_groupe_id" &&
        /(pac|geother|solaire|renov|contrainte|opportunite|faisabilite)/i.test(key)
      )
      .slice(0, 8)
      .map(([key, value]) => [humanizeKey(key), value]);
    const totalHousing = ffo.nb_log ?? building.nb_log ?? null;
    const socialHousing = rpls.nb_log ?? null;
    const socialShare =
      totalHousing && socialHousing != null
        ? `${Math.round((Number(socialHousing) / Number(totalHousing)) * 100)} %`
        : null;

    const synthesisHtml = renderObservatorySynthesis({
      totalHousing,
      socialHousing,
      socialShare,
      dpeClass,
      dpeDate,
      isInQpv
    });

    const qpvStatusHtml = `
      <div class="qpv-status-panel ${isInQpv === true ? "in" : isInQpv === false ? "out" : "unknown"}">
        <div class="label">Situation au regard de la politique de la ville</div>
        <div class="value">${
          context.isInQpv === true
            ? "Dans un quartier prioritaire"
            : context.isInQpv === false
              ? "Hors quartier prioritaire"
              : "Information non disponible"
        }</div>
      </div>`;

    $("#drawer-body").innerHTML =
      qpvStatusHtml +
      synthesisHtml +
      `<div class="summary-cards">
        <div class="summary-card"><div class="n">Logements</div><div class="v">${escapeHtml(valueOrDash(totalHousing))}</div></div>
        <div class="summary-card"><div class="n">Logements sociaux</div><div class="v">${escapeHtml(valueOrDash(socialHousing))}</div></div>
        <div class="summary-card"><div class="n">Part sociale</div><div class="v">${escapeHtml(valueOrDash(socialShare))}</div></div>
      </div>` +
      renderIdentity(state.selectedFeature) +
      renderParcelSection() +
      renderDvfSection() +
      renderSitadelSection() +
      `<div class="section-title">Logement et habitat</div>
       ${rplsHtml}
       ${dpeHtml}
       ${generalRows.length ? sectionBlock("Caractéristiques du bâtiment", generalRows) : ""}
       ${coproRows.length ? sectionBlock("Copropriété", coproRows) : ""}
       ${risksRows.length ? sectionBlock("Risques", risksRows) : ""}
       ${renovationRows.length ? sectionBlock("Rénovation et énergies renouvelables", renovationRows) : ""}
       <div class="notice">
         <strong>Lecture métier :</strong> les informations sont issues de bases différentes,
         avec leurs propres millésimes. Elles constituent une aide à l’analyse et doivent être
         vérifiées avant toute décision administrative individuelle.
       </div>`;
  }

  function renderObservatorySynthesis(context) {
    const sourceCard = (name, value, detail, available, pending = false) => {
      const className = pending ? "pending" : (available ? "available" : "absent");
      return `<div class="summary-source ${className}">
        <div class="top"><span class="name">${escapeHtml(name)}</span><span class="mini-light"></span></div>
        <div class="value">${escapeHtml(valueOrDash(value))}</div>
        <div class="detail">${escapeHtml(detail)}</div>
      </div>`;
    };

    const dvfPending = state.apiStatus.dvf?.state === "pending";
    const sitadelPending = state.apiStatus.sitadel?.state === "pending";
    const cadastrePending = state.apiStatus.cadastre?.state === "pending";

    return `<section class="observatory-summary">
      <div class="observatory-summary-head">
        <div>
          <h3>Synthèse du bâtiment</h3>
          <p>Les informations les plus utiles, réunies en un seul regard.</p>
        </div>
        <span class="badge">BDNB 2026-02.a</span>
      </div>
      <div class="summary-source-grid">
        ${sourceCard(
          "Parc social",
          Number(context.socialHousing) > 0 ? "Oui" : "Non",
          Number(context.socialHousing) > 0
            ? `${context.socialHousing} logement(s) RPLS · millésime 2024`
            : "Aucun logement RPLS rattaché · millésime 2024",
          Number(context.socialHousing) > 0
        )}
        ${sourceCard(
          "DPE",
          context.dpeClass || "Absent",
          context.dpeDate ? `Diagnostic du ${formatDate(context.dpeDate)}` : "Aucun DPE représentatif",
          Boolean(context.dpeClass)
        )}
        ${sourceCard(
          "Cadastre",
          cadastrePending ? "…" : (state.parcels.length ? `${state.parcels.length} parcelle(s)` : "Absent"),
          state.parcels.length
            ? `${parcelReferences().join(", ")}`
            : "Aucune parcelle récupérée",
          state.parcels.length > 0,
          cadastrePending
        )}
        ${sourceCard(
          "DVF+",
          dvfPending ? "…" : (state.dvf.length ? `${state.dvf.length} mutation(s)` : "Aucune"),
          state.dvf.length
            ? `Dernière mutation : ${formatDate(state.dvf[0].datemut || state.dvf[0].date_mutation || "")}`
            : "Aucune transaction rapprochée",
          state.dvf.length > 0,
          dvfPending
        )}
        ${sourceCard(
          "Sitadel",
          sitadelPending ? "…" : (state.sitadel.length ? `${state.sitadel.length} dossier(s)` : "Aucun"),
          state.sitadel.length
            ? "Autorisation(s) rapprochée(s) par parcelle ou adresse"
            : "Aucune autorisation rapprochée",
          state.sitadel.length > 0,
          sitadelPending
        )}
        ${sourceCard(
          "QPV",
          context.isInQpv === true ? "Oui" : context.isInQpv === false ? "Non" : "—",
          context.isInQpv === true
            ? "Bâtiment indiqué dans un QPV par la BDNB / RPLS"
            : context.isInQpv === false
              ? "Bâtiment indiqué hors QPV par la BDNB / RPLS"
              : "Information non disponible dans la réponse BDNB",
          context.isInQpv === true
        )}
      </div>
    </section>`;
  }

  function sectionBlock(title, rows) {
    const normalized = title.toLowerCase();
    let className = "general-block";
    let icon = "INFO";
    if (normalized.includes("copro")) { className = "copro-block"; icon = "COPRO"; }
    if (normalized.includes("risque")) { className = "risk-block"; icon = "!"; }
    if (normalized.includes("rénov")) { className = "renovation-block"; icon = "ÉCO"; }
    return `<div class="block ${className}">
      <div class="block-title-row">
        <div class="block-title">${escapeHtml(title)}</div>
        <div class="block-icon">${escapeHtml(icon)}</div>
      </div>
      <div class="data-grid">
        ${rows.map(([label, value]) => dataRow(label, value)).join("")}
      </div>
    </div>`;
  }

  function yesNo(value) {
    if (value === true) return "Oui";
    if (value === false) return "Non";
    return null;
  }

  function yesNoNullable(value) {
    return yesNo(value);
  }

  function formatList(value) {
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "string") {
      return value.replace(/^\{|\}$/g, "").replace(/","/g, ", ").replace(/"/g, "");
    }
    return value;
  }

  function humanizeKey(value) {
    return String(value)
      .replace(/_/g, " ")
      .replace(/\b\w/g, char => char.toUpperCase());
  }


  async function loadSitadelForFeature(feature) {
    state.sitadel = [];
    state.sitadelLoadedFor = featureRnbId(feature);

    const p = feature?.properties || {};
    const address = Array.isArray(p.addresses) ? p.addresses[0] || {} : {};
    const codeInsee = String(address.city_insee_code || "").trim();
    if (!codeInsee || !window.Papa) return;

    const candidateColumns = [
      "COMMUNE_CODE",
      "CODE_COMMUNE",
      "CODE_INSEE_COMMUNE",
      "CODCOM",
      "DEP_CODE_COMMUNE"
    ];

    for (const column of candidateColumns) {
      try {
        const params = new URLSearchParams({
          "withColumnName": "true",
          "withColumnDescription": "false",
          "withColumnUnit": "false",
          [column]: `contains:${codeInsee}`
        });
        const url = `${CFG.didoBase}/${CFG.sitadelDatafile}/csv?${params}`;
        const response = await fetch(url, { cache: "no-store", mode: "cors" });
        if (!response.ok) continue;
        const text = await response.text();
        const parsed = Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: false
        });
        const rows = (parsed.data || []).filter(row => row && Object.keys(row).length);
        const matched = rows.filter(row => rowContainsCommune(row, codeInsee));
        if (matched.length) {
          state.sitadel = matchSitadelToBuilding(matched, feature);
          setApiStatus(
            "sitadel",
            state.sitadel.length ? "ok" : "warn",
            state.sitadel.length ? `${state.sitadel.length} dossier(s)` : "Aucun dossier"
          );
          refreshDrawerAfterSitadel();
          return;
        }
      } catch (error) {
        console.warn("Sitadel", column, error);
      }
    }
    setApiStatus("sitadel", "warn", "Aucun dossier");
    refreshDrawerAfterSitadel();
  }

  function rowContainsCommune(row, codeInsee) {
    return Object.entries(row || {}).some(([key, value]) =>
      /(commune|codcom|insee)/i.test(key) &&
      String(value || "").replace(/\D/g, "").includes(codeInsee)
    );
  }

  function matchSitadelToBuilding(rows, feature) {
    const parcelRefs = parcelReferences().map(normalizeParcelId);
    const p = feature?.properties || {};
    const addresses = Array.isArray(p.addresses) ? p.addresses : [];
    const street = normalizeText(formatAddress(addresses[0] || {}));

    const scored = rows.map(row => {
      const values = Object.values(row || {}).map(value => String(value || ""));
      const compact = normalizeText(values.join(" "));
      let score = 0;

      for (const parcel of parcelRefs) {
        const sectionNumber = parcel.slice(-6);
        if (parcel && compact.includes(parcel)) score += 20;
        else if (sectionNumber && compact.includes(sectionNumber)) score += 8;
      }

      if (street) {
        const streetWords = street.split(" ").filter(word => word.length > 3);
        score += streetWords.filter(word => compact.includes(word)).length * 2;
      }
      return { row, score };
    });

    const strong = scored.filter(item => item.score >= 8);
    return (strong.length ? strong : [])
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(item => item.row);
  }

  function normalizeParcelId(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function renderSitadelSection() {
    if (!state.sitadel.length) return "";

    return `<div class="section-title">Autorisations d’urbanisme</div>
      <div class="block sitadel-block">
        <div class="block-title-row">
          <div>
            <div class="block-title">Sitadel</div>
            <div class="section-intro">Autorisations réellement rapprochées par parcelle ou adresse.</div>
          </div>
          <div class="block-icon">AU</div>
        </div>
        <div class="authorization-list">
          ${state.sitadel.map(row => {
            const type = pickField(row, [
              "TYPE_AUTORISATION", "TYPE_DAU", "NATURE_AUTORISATION",
              "TYPE_DOSSIER", "NATURE_DAU"
            ]) || "Autorisation";
            const number = pickField(row, [
              "NUMERO_AUTORISATION", "NUMERO_DOSSIER", "NUM_DAU",
              "NUMERO_PC", "NUMERO_PERMIS"
            ]);
            const date = pickField(row, [
              "DATE_AUTORISATION", "DATE_DECISION", "DATE_DEPOT",
              "DATE_REELLE_AUTORISATION", "DATE_PRISE_EN_COMPTE"
            ]);
            const housing = pickField(row, [
              "NB_LOGEMENTS", "NOMBRE_LOGEMENTS", "NB_LOGT",
              "LOGEMENTS_AUTORISES", "NB_LGT"
            ]);
            const surface = pickField(row, [
              "SURFACE_CREEE", "SURFACE_PLANCHER", "SHON_CREEE",
              "SURFACE_LOCAUX"
            ]);
            const status = pickField(row, [
              "ETAT_DOSSIER", "STATUT", "DECISION", "ETAT_AUTORISATION"
            ]);
            return `<div class="authorization-card">
              <div class="authorization-top">
                <div>
                  <div class="authorization-kind">${escapeHtml(valueOrDash(type))}</div>
                  <div class="authorization-title">${escapeHtml(number || "Dossier Sitadel")}</div>
                </div>
                <div class="authorization-date">${escapeHtml(date ? formatDate(date) : "—")}</div>
              </div>
              <div class="authorization-meta">
                ${status ? `État : ${escapeHtml(valueOrDash(status))}` : ""}
                ${housing ? ` · Logements : ${escapeHtml(valueOrDash(housing))}` : ""}
                ${surface ? ` · Surface : ${escapeHtml(valueOrDash(surface))} m²` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="source-line">
          <span class="source-tag">Sitadel · SDES · mise à jour mensuelle</span>
        </div>
      </div>`;
  }

  function pickField(row, candidates) {
    const entries = Object.entries(row || {});
    for (const candidate of candidates) {
      const exact = entries.find(([key]) => normalizeKeyName(key) === normalizeKeyName(candidate));
      if (exact && exact[1] !== null && exact[1] !== undefined && exact[1] !== "") return exact[1];
    }
    for (const candidate of candidates) {
      const normalized = normalizeKeyName(candidate);
      const fuzzy = entries.find(([key, value]) =>
        normalizeKeyName(key).includes(normalized) &&
        value !== null && value !== undefined && value !== ""
      );
      if (fuzzy) return fuzzy[1];
    }
    return null;
  }

  function normalizeKeyName(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function refreshDrawerAfterSitadel() {
    if (!state.currentBdnb || !state.selectedFeature) return;
    if (state.sitadelLoadedFor !== featureRnbId(state.selectedFeature)) return;
    renderBdnb(state.currentBdnb, state.currentEnvelope || {});
  }

  async function loadDvfForFeature(feature) {
    state.dvf = [];
    state.dvfLoadedFor = featureRnbId(feature);

    const center = L.geoJSON(feature).getBounds().getCenter();
    const p = feature?.properties || {};
    const address = Array.isArray(p.addresses) ? p.addresses[0] || {} : {};
    const codeInsee = String(address.city_insee_code || "");
    const refs = parcelReferences();

    const requests = [];
    if (center && Number.isFinite(center.lng) && Number.isFinite(center.lat)) {
      requests.push({
        path: "dvf_opendata/geomutations",
        params: { contains_lon_lat: `${center.lng},${center.lat}`, page_size: "30" }
      });
      requests.push({
        path: "dvf_opendata/mutations",
        params: { contains_lon_lat: `${center.lng},${center.lat}`, ordering: "-datemut", page_size: "30" }
      });
    }

    if (codeInsee) {
      requests.push({
        path: "dvf_opendata/mutations",
        params: { code_insee: codeInsee, ordering: "-datemut", page_size: "200" }
      });
    }

    for (const base of CFG.dvfApiBases) {
      for (const request of requests) {
        try {
          const params = new URLSearchParams(request.params);
          const response = await getJSON(`${base}/${request.path}?${params}`);
          const rows = rowsOf(response);
          const matched = matchDvfRows(rows, refs, center);
          if (matched.length) {
            state.dvf = matched.slice(0, 12);
            setApiStatus("dvf", "ok", `${state.dvf.length} mutation(s)`);
            refreshDrawerAfterDvf();
            return;
          }
        } catch (error) {
          console.warn("DVF indisponible", base, request.path, error);
        }
      }
    }

    state.dvf = [];
    setApiStatus("dvf", "warn", "Aucune mutation");
    refreshDrawerAfterDvf();
  }

  function matchDvfRows(rows, parcelRefs, center) {
    const normalizedRefs = parcelRefs.map(normalizeParcelId);
    return (rows || []).filter(row => {
      const compact = normalizeParcelId(Object.values(row || {}).join(" "));
      if (normalizedRefs.some(ref => ref && compact.includes(ref))) return true;
      const lat = Number(row.lat || row.latitude || row.y);
      const lon = Number(row.lon || row.longitude || row.x);
      if (center && Number.isFinite(lat) && Number.isFinite(lon)) {
        return map.distance([lat, lon], center) <= 65;
      }
      return false;
    }).sort((a, b) =>
      String(b.datemut || b.date_mutation || "").localeCompare(
        String(a.datemut || a.date_mutation || "")
      )
    );
  }

  function refreshDrawerAfterDvf() {
    if (!state.currentBdnb || !state.selectedFeature) return;
    if (state.dvfLoadedFor !== featureRnbId(state.selectedFeature)) return;
    renderBdnb(state.currentBdnb, state.currentEnvelope || {});
  }

  function renderDvfSection() {
    if (!state.dvf.length) return "";

    const transactions = state.dvf
      .slice()
      .sort((a, b) => String(b.datemut || b.date_mutation || "").localeCompare(String(a.datemut || a.date_mutation || "")))
      .slice(0, 8);

    return `<div class="section-title">Marché immobilier</div>
      <div class="block dvf-block">
        <div class="block-title-row">
          <div>
            <div class="block-title">Transactions DVF+</div>
            <div class="section-intro">Mutations dont la géométrie contient le point central du bâtiment.</div>
          </div>
          <div class="block-icon">DVF</div>
        </div>
        <div class="transaction-list">
          ${transactions.map(item => {
            const date = item.datemut || item.date_mutation || item.date_mut || null;
            const price = item.valeurfonc ?? item.valeur_fonciere ?? null;
            const nature = item.libnatmut || item.nature_mutation || item.natmut || "Mutation";
            const type = item.libtypbien || item.typbien || item.codtypbien || null;
            const built = item.sbati ?? item.surface_batie ?? null;
            const land = item.sterr ?? item.surface_terrain ?? null;
            return `<div class="transaction-card">
              <div class="transaction-top">
                <div>
                  <div class="transaction-date">${escapeHtml(date ? formatDate(date) : "Date non renseignée")}</div>
                  <strong>${escapeHtml(valueOrDash(nature))}</strong>
                </div>
                <div class="transaction-price">${price != null ? escapeHtml(formatEuro(price)) : "—"}</div>
              </div>
              <div class="transaction-meta">
                ${type ? `Type : ${escapeHtml(valueOrDash(type))}` : ""}
                ${built != null ? ` · Surface bâtie : ${escapeHtml(valueOrDash(built))} m²` : ""}
                ${land != null ? ` · Terrain : ${escapeHtml(valueOrDash(land))} m²` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="source-line">
          <span class="source-tag">DVF+ open data · Cerema</span>
        </div>
      </div>`;
  }

  function formatEuro(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return valueOrDash(value);
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0
    }).format(number);
  }

  async function loadCadastreForFeature(feature) {
    state.parcels = [];
    if (state.parcelLayer) {
      state.parcelLayer.remove();
      state.parcelLayer = null;
    }
    parcelLegend.style.display = "none";

    const geometry = feature?.geometry;
    if (!geometry) return;

    try {
      const encodedGeom = encodeURIComponent(JSON.stringify(geometry));
      let response;

      try {
        response = await getJSON(`${CFG.cadastreApi}?geom=${encodedGeom}`);
      } catch (getError) {
        const postResponse = await fetch(CFG.cadastreApi, {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ geom: geometry })
        });
        if (!postResponse.ok) throw new Error(`Cadastre HTTP ${postResponse.status}`);
        response = await postResponse.json();
      }

      const features =
        response?.features ||
        response?.data?.features ||
        (Array.isArray(response) ? response : []);

      state.parcels = rankParcelsByOverlap(
        features.map(parcel => normalizeParcel(parcel)).filter(Boolean),
        feature
      );
      setApiStatus("cadastre", state.parcels.length ? "ok" : "warn", state.parcels.length ? `${state.parcels.length} parcelle(s)` : "Aucun résultat");

      if (state.parcels.length) {
        state.parcelLayer = L.geoJSON({
          type: "FeatureCollection",
          features: state.parcels
        }, {
          style: {
            color: "#8d533e",
            weight: 2.2,
            fillColor: "#8d533e",
            fillOpacity: .035,
            dashArray: "3 3"
          },
          onEachFeature(parcel, layer) {
            const label = parcelReference(parcel) || "Parcelle cadastrale";
            layer.bindTooltip(label, { sticky: true });
          }
        }).addTo(map);
        state.parcelLayer.bringToFront();
        if (state.geoLayer) state.geoLayer.bringToFront();
        parcelLegend.style.display = "";
      }

      refreshDrawerAfterParcels();
    } catch (error) {
      console.warn("Cadastre non chargé", error);
      setApiStatus("cadastre", "ko", "Indisponible");
      state.parcels = [];
      refreshDrawerAfterParcels();
    }
  }

  function rankParcelsByOverlap(parcels, buildingFeature) {
    if (!window.turf || !buildingFeature?.geometry) {
      return parcels.map((parcel, index) => ({
        ...parcel,
        properties: {
          ...(parcel.properties || {}),
          _parcel_role: index === 0 ? "principale" : "secondaire",
          _overlap_ratio: null
        }
      }));
    }

    let buildingArea = 0;
    try { buildingArea = turf.area(buildingFeature); } catch (_) {}

    const ranked = parcels.map(parcel => {
      let overlapArea = 0;
      try {
        const intersection = turf.intersect(
          turf.featureCollection([buildingFeature, parcel])
        );
        if (intersection) overlapArea = turf.area(intersection);
      } catch (_) {}

      const ratio = buildingArea > 0 ? overlapArea / buildingArea : 0;
      return { parcel, overlapArea, ratio };
    })
    .filter(item => item.overlapArea > 0.5 && item.ratio > 0.005)
    .sort((a, b) => b.overlapArea - a.overlapArea);

    return ranked.map((item, index) => ({
      ...item.parcel,
      properties: {
        ...(item.parcel.properties || {}),
        _parcel_role: index === 0 ? "principale" : "secondaire",
        _overlap_area: item.overlapArea,
        _overlap_ratio: item.ratio
      }
    }));
  }

  function normalizeParcel(parcel) {
    if (!parcel) return null;
    if (parcel.type === "Feature") return parcel;
    if (parcel.geometry || parcel.geom) {
      return {
        type: "Feature",
        geometry: parcel.geometry || parcel.geom,
        properties: parcel.properties || parcel
      };
    }
    return null;
  }

  function parcelReference(parcel) {
    const p = parcel?.properties || {};
    const full =
      p.id ||
      p.idu ||
      p.numero ||
      p.parcelle ||
      p.code_parcelle ||
      null;
    if (full) return String(full);

    const prefix = p.code_dep || p.departement || "";
    const commune = p.code_com || p.commune || p.code_insee || "";
    const section = p.section || p.code_section || "";
    const number = p.numero || p.numero_parcelle || "";
    return [prefix, commune, section, number].filter(Boolean).join(" ");
  }

  function parcelReferences() {
    const refs = state.parcels.map(parcelReference).filter(Boolean);
    if (refs.length) return refs;
    const p = state.selectedFeature?.properties || {};
    const plots = Array.isArray(p.plots) ? p.plots : [];
    return plots.map(item => item?.id || item).filter(Boolean);
  }

  function refreshDrawerAfterParcels() {
    if (!state.currentBdnb || !state.selectedFeature) return;
    renderBdnb(state.currentBdnb, state.currentEnvelope || {});
  }

  function renderParcelSection() {
    const refs = parcelReferences();
    if (!refs.length) {
      return `<div class="section-title">Cadastre</div>
        <div class="block parcel-block">
          <div class="block-title-row">
            <div class="block-title">Parcelle cadastrale</div>
            <div class="block-icon">CAD</div>
          </div>
          <div class="notice"><strong>Aucune parcelle n’a pu être identifiée automatiquement.</strong><br>
          La fiche bâtiment reste disponible sans cette information.</div>
        </div>`;
    }

    const propsRows = [];
    for (const parcel of state.parcels) {
      const p = parcel.properties || {};
      const ref = parcelReference(parcel);
      if (ref) propsRows.push([
        `Référence cadastrale${p._parcel_role ? ` (${p._parcel_role})` : ""}`,
        ref
      ]);
      if (p._overlap_ratio != null) {
        propsRows.push(["Part de l’emprise du bâtiment", `${Math.round(p._overlap_ratio * 100)} %`]);
      }
      if (p.contenance) propsRows.push(["Contenance", `${p.contenance} m²`]);
      if (p.code_insee) propsRows.push(["Code INSEE", p.code_insee]);
      if (p.section) propsRows.push(["Section", p.section]);
      if (p.numero) propsRows.push(["Numéro", p.numero]);
    }

    return `<div class="section-title">Cadastre</div>
      <div class="block parcel-block">
        <div class="block-title-row">
          <div>
            <div class="block-title">Parcelle${refs.length > 1 ? "s" : ""} cadastrale${refs.length > 1 ? "s" : ""}</div>
            <div class="section-intro">Références et géométries récupérées dynamiquement par intersection avec le bâtiment.</div>
          </div>
          <div class="block-icon">CAD</div>
        </div>
        <div class="parcel-list">
          ${state.parcels.length
            ? state.parcels.map(parcel => {
                const ref = parcelReference(parcel);
                const role = parcel.properties?._parcel_role || "secondaire";
                return `<span class="parcel-chip ${role === "principale" ? "primary" : "secondary"}">
                  ${escapeHtml(ref)} · ${role === "principale" ? "principale" : "secondaire"}
                </span>`;
              }).join("")
            : refs.map(ref => `<span class="parcel-chip">${escapeHtml(ref)}</span>`).join("")}
        </div>
        ${state.parcels.length > 1 ? `<div class="parcel-explanation">
          Le bâtiment intersecte plusieurs parcelles. La parcelle principale est celle qui contient
          la plus grande part de son emprise ; les autres sont signalées comme secondaires.
        </div>` : ""}
        ${propsRows.length ? `<div class="data-grid" style="margin-top:10px">
          ${propsRows.map(([label,value]) => dataRow(label,value)).join("")}
        </div>` : ""}
        <div class="source-line"><span class="source-tag">API Carto IGN · PCI Express</span></div>
      </div>`;
  }

  function renderIdentity(feature) {
    const p = feature?.properties || {};
    const addresses = Array.isArray(p.addresses) ? p.addresses : [];
    const plots = Array.isArray(p.plots) ? p.plots : [];
    const address = addresses[0] || {};
    return `<div class="section-title">Identité RNB</div>
      <div class="block identity-block">
        <div class="data-grid">
          ${dataRow("ID-RNB", featureRnbId(feature), "is-key")}
          ${dataRow("Statut", p.status)}
          ${dataRow("Adresse", formatAddress(address))}
          ${dataRow("Commune", address.city_name)}
          ${dataRow("Code INSEE", address.city_insee_code)}
          ${dataRow("Parcelle(s)", parcelReferences().join(", ") || null)}
        </div>
      </div>`;
  }





  function metric(label, value, unit = "") {
    return `<div class="metric"><div class="v">${escapeHtml(valueOrDash(value))}${value !== null && value !== undefined && unit ? `<small> ${escapeHtml(unit)}</small>` : ""}</div><div class="l">${escapeHtml(label)}</div></div>`;
  }

  function dataRow(label, value, emphasis = "") {
    const display = valueOrDash(value);
    let semantic = emphasis;
    let valueClass = "";
    if (display === "Oui") { semantic = semantic || "is-yes"; valueClass = "yes"; }
    if (display === "Non") { semantic = semantic || "is-no"; valueClass = "no"; }
    return `<div class="data-row ${semantic}"><div class="l">${escapeHtml(label)}</div><div class="v ${valueClass}">${escapeHtml(display)}</div></div>`;
  }

  function valueOrDash(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (value === true) return "Oui";
    if (value === false) return "Non";
    if (Array.isArray(value)) return value.map(valueOrDash).join(", ");
    if (typeof value === "object") return Object.entries(value)
      .map(([key, val]) => `${humanizeKey(key)} : ${valueOrDash(val)}`)
      .join(" · ");
    const text = String(value);
    if (text.toLowerCase() === "true") return "Oui";
    if (text.toLowerCase() === "false") return "Non";
    return text;
  }

  function formatAddress(a = {}) {
    const line = [a.street_number, a.street_rep, a.street].filter(Boolean).join(" ");
    const city = [a.city_zipcode, a.city_name].filter(Boolean).join(" ");
    return [line, city].filter(Boolean).join(", ");
  }

  function formatDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString("fr-FR");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, c => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"
    })[c]);
  }

  function skeletonBlock() {
    return `<div class="section-title">BDNB</div><div class="block bdnb-loading-block"><div class="summary-text">Chargement des données consolidées…</div></div>`;
  }



  function selectedQpvContext() {
    return null;
  }

  async function exportBuildingSheet() {
    if (!state.selectedFeature || !state.currentBdnb) {
      alert("Sélectionnez d’abord un bâtiment dont la fiche est complètement chargée.");
      return;
    }

    if (!window.jspdf?.jsPDF) {
      alert("Le module PDF n’a pas pu être chargé. Vérifiez l’accès à cdn.jsdelivr.net puis rechargez la page.");
      return;
    }

    const previewWindow = window.open("", "_blank");
    if (!previewWindow) {
      alert("Le navigateur a bloqué l’ouverture de la fiche PDF.");
      return;
    }
    previewWindow.document.write("<title>Préparation de la fiche PDF…</title><p style='font-family:Arial;padding:24px'>Création de la fiche PDF…</p>");

    const button = $("#btn-export");
    button.classList.add("loading");
    button.textContent = "Préparation du PDF…";

    let mapImage = null;

    try {
      mapImage = await captureRealMap();
    } catch (error) {
      console.warn("Capture cartographique impossible", error);
    }

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 14;
      const contentWidth = pageWidth - margin * 2;
      const logo = document.querySelector(".brand-logo")?.src || null;

      const p = state.selectedFeature.properties || {};
      const address = Array.isArray(p.addresses) ? p.addresses[0] || {} : {};
      const envelope = state.currentEnvelope || {};
      const data = state.currentBdnb;
      const rpls = data.rpls || {};
      const qpvRaw =
        rpls.dans_qpv ??
        rpls.dans_qp ??
        rpls.qpv ??
        data?.building?.dans_qpv ??
        data?.ffo?.dans_qpv ??
        null;
      const isInQpv = normalizeBoolean(qpvRaw);
      const isSocialHousing = Number(rpls.nb_log) > 0;
      const generated = new Date().toLocaleString("fr-FR");
      const bdnbVintage = envelope.millesime || "2026-02.a";
      const titleAddress = formatAddress(address) || featureRnbId(state.selectedFeature);

      const palette = {
        identity: [0, 0, 145],
        parcel: [141, 83, 62],
        dvf: [165, 88, 160],
        rpls: [111, 76, 155],
        dpe: [24, 117, 60],
        usage: [71, 85, 105],
        copro: [87, 112, 190],
        risks: [184, 117, 42],
        renovation: [0, 144, 153],
        neutral: [71, 85, 105]
      };

      let cursorY = 14;
      let sectionCount = 0;

      function addFirstPageHeader() {
        if (logo) {
          try { doc.addImage(logo, "JPEG", margin, 10, 27, 22); } catch (error) { console.warn("Logo PDF", error); }
        }
        doc.setTextColor(0, 0, 145);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        doc.text("Observatoire du bâti du Val-d’Oise", margin + 32, 17);
        doc.setTextColor(71, 85, 105);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.text("Fiche complète du bâtiment", margin + 32, 23);
        doc.setFontSize(8);
        doc.text(doc.splitTextToSize(String(titleAddress), contentWidth - 32), margin + 32, 28);
        doc.setDrawColor(0, 0, 145);
        doc.setLineWidth(1.3);
        doc.line(margin, 35, pageWidth - margin, 35);
        cursorY = 41;
      }

      function addFooter(pageNumber) {
        doc.setDrawColor(215, 222, 234);
        doc.setLineWidth(.2);
        doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.text("DDT du Val-d’Oise · Observatoire du bâti", margin, pageHeight - 7);
        doc.text(`Page ${pageNumber}`, pageWidth - margin, pageHeight - 7, { align: "right" });
      }

      function ensureSpace(heightNeeded = 28) {
        if (cursorY + heightNeeded > pageHeight - 18) {
          doc.addPage();
          cursorY = 16;
        }
      }

      function cleanRows(object, labels = {}) {
        return Object.entries(object || {})
          .filter(([key, value]) =>
            !["geom", "geometry", "shape", "point", "geom_groupe"].includes(key) &&
            value !== null && value !== undefined && value !== "" &&
            !(typeof value === "object" && !Array.isArray(value))
          )
          .map(([key, value]) => [labels[key] || humanizeKey(key), valueOrDash(value)]);
      }

      function addSection(title, rows, color, note = null, options = {}) {
        if (!rows.length && !note && !options.mapImage) return;

        if (sectionCount > 0) {
          doc.addPage();
          cursorY = 16;
        }
        sectionCount += 1;

        doc.setFillColor(...color);
        doc.roundedRect(margin, cursorY, contentWidth, 8, 2, 2, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(title, margin + 4, cursorY + 5.4);
        cursorY += 11;

        if (options.mapImage) {
          const ratio = options.mapImage.height / options.mapImage.width;
          const imageHeight = Math.min(82, contentWidth * ratio);
          doc.addImage(options.mapImage.dataUrl, "PNG", margin, cursorY, contentWidth, imageHeight, undefined, "FAST");
          cursorY += imageHeight + 5;
        }

        if (note) {
          ensureSpace(18);
          doc.setFillColor(247, 249, 252);
          doc.setDrawColor(215, 222, 234);
          doc.setTextColor(51, 65, 85);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8.4);
          const lines = doc.splitTextToSize(note, contentWidth - 8);
          const h = lines.length * 4 + 5;
          doc.roundedRect(margin, cursorY, contentWidth, h, 2, 2, "FD");
          doc.text(lines, margin + 4, cursorY + 5);
          cursorY += h + 4;
        }

        if (rows.length) {
          doc.autoTable({
            startY: cursorY,
            margin: { left: margin, right: margin, top: 16, bottom: 18 },
            head: [["Information", "Valeur"]],
            body: rows,
            theme: "grid",
            tableWidth: contentWidth,
            pageBreak: "auto",
            rowPageBreak: "avoid",
            showHead: "everyPage",
            styles: {
              font: "helvetica",
              fontSize: 8,
              cellPadding: 2.6,
              overflow: "linebreak",
              valign: "middle",
              lineColor: [220, 226, 235],
              lineWidth: .15,
              textColor: [17, 24, 39],
              minCellHeight: 6
            },
            headStyles: {
              fillColor: color,
              textColor: [255, 255, 255],
              fontStyle: "bold"
            },
            columnStyles: {
              0: { cellWidth: 62, fontStyle: "bold", textColor: [71, 85, 105], fillColor: [248, 250, 252] },
              1: { cellWidth: contentWidth - 62 }
            },
            didDrawPage: data => {
              cursorY = data.cursor?.y || cursorY;
            }
          });
          cursorY = doc.lastAutoTable.finalY + 7;
        }
      }

      addFirstPageHeader();

      const parcelRefs = parcelReferences();
      const identityRows = [
        ["ID-RNB", featureRnbId(state.selectedFeature)],
        ["Adresse", formatAddress(address)],
        ["Commune", address.city_name],
        ["Code INSEE", address.city_insee_code],
        ["Code postal", address.city_zipcode],
        ["Statut RNB", p.status],
        ["Parcelle(s)", parcelRefs.join(", ") || "Non renseignée"],
        ["Situation QPV", isInQpv === true ? "Oui" : isInQpv === false ? "Non" : "Non renseignée"],
        ["Source QPV", "BDNB / RPLS 2024"],
        ["Millésime QPV", "2024"]
      ].filter(([, value]) => value !== null && value !== undefined && value !== "");

      addSection(
        "Localisation et contexte",
        identityRows,
        palette.identity,
        mapImage ? "Vue cartographique réelle : fond OpenStreetMap, voies, toponymes, parcelles et bâtiment sélectionné." : null,
        mapImage ? { mapImage } : {}
      );

      const parcelRows = [];
      for (const parcel of state.parcels) {
        const pp = parcel.properties || {};
        const ref = parcelReference(parcel);
        if (ref) parcelRows.push(["Référence cadastrale", ref]);
        if (pp.contenance) parcelRows.push(["Contenance", `${pp.contenance} m²`]);
        if (pp.section) parcelRows.push(["Section", pp.section]);
        if (pp.numero) parcelRows.push(["Numéro", pp.numero]);
      }
      if (parcelRows.length) {
        addSection("Parcelles cadastrales", parcelRows, palette.parcel,
          "Géométries et références récupérées par intersection via l’API Carto de l’IGN.");
      }

      if (state.dvf.length) {
        const dvfRows = state.dvf.slice(0, 20).flatMap((item, index) => {
          const prefix = `Mutation ${index + 1}`;
          return [
            [`${prefix} - Date`, item.datemut || item.date_mutation || null],
            [`${prefix} - Nature`, item.libnatmut || item.nature_mutation || item.natmut || null],
            [`${prefix} - Valeur foncière`, item.valeurfonc != null ? formatEuro(item.valeurfonc) : null],
            [`${prefix} - Type de bien`, item.libtypbien || item.typbien || item.codtypbien || null],
            [`${prefix} - Surface bâtie`, item.sbati != null ? `${item.sbati} m²` : null],
            [`${prefix} - Surface terrain`, item.sterr != null ? `${item.sterr} m²` : null]
          ].filter(([, value]) => value !== null && value !== undefined && value !== "");
        });
        addSection("Transactions immobilières - DVF+", dvfRows, palette.dvf,
          "Mutations ouvertes rapprochées par parcelle cadastrale ou proximité immédiate.");
      }

      if (state.sitadel.length) {
        const sitadelRows = state.sitadel.flatMap((row, index) => {
          const prefix = `Autorisation ${index + 1}`;
          const values = [
            [`${prefix} - Type`, pickField(row, ["TYPE_AUTORISATION","TYPE_DAU","NATURE_AUTORISATION","TYPE_DOSSIER"])],
            [`${prefix} - Numéro`, pickField(row, ["NUMERO_AUTORISATION","NUMERO_DOSSIER","NUM_DAU","NUMERO_PC"])],
            [`${prefix} - Date`, pickField(row, ["DATE_AUTORISATION","DATE_DECISION","DATE_DEPOT"])],
            [`${prefix} - État`, pickField(row, ["ETAT_DOSSIER","STATUT","DECISION"])],
            [`${prefix} - Logements`, pickField(row, ["NB_LOGEMENTS","NOMBRE_LOGEMENTS","NB_LOGT","NB_LGT"])],
            [`${prefix} - Surface`, pickField(row, ["SURFACE_CREEE","SURFACE_PLANCHER","SHON_CREEE"])]
          ];
          return values.filter(([, value]) => value !== null && value !== undefined && value !== "");
        });
        addSection("Autorisations d’urbanisme - Sitadel", sitadelRows, [179, 64, 0],
          "Dossiers Sitadel rapprochés par référence cadastrale ou adresse. Mise à jour mensuelle du SDES.");
      }

      const rplsNote = isSocialHousing
        ? "Bâtiment relevant du parc locatif social : Oui. Données RPLS millésime 2024, agrégées par la BDNB."
        : "Bâtiment relevant du parc locatif social : Non. Aucun logement RPLS n’est rattaché à ce bâtiment dans la BDNB pour le millésime 2024.";
      addSection("Parc locatif social - RPLS 2024", cleanRows(data.rpls || {}), palette.rpls, rplsNote);
      addSection("DPE représentatif", cleanRows(data.dpe || {}), palette.dpe,
        data.dpe ? "Diagnostic représentatif sélectionné par la méthodologie BDNB." : "Aucun DPE représentatif disponible.");
      addSection("Usage et propriété", cleanRows(data.usage || {}), palette.usage);
      addSection("Copropriété - RNC", cleanRows(data.rnc || {}), palette.copro);
      addSection("Risques", cleanRows(data.risks || {}), palette.risks);
      addSection("Caractéristiques physiques", cleanRows(data.bdtopo || {}), palette.neutral);
      addSection("Rénovation et opportunités", cleanRows(data.renovation || {}), palette.renovation);
      addSection("Bâtiment", cleanRows(data.building || {}), palette.neutral);
      addSection("Fichiers fonciers ouverts", cleanRows(data.ffo || {}), palette.neutral);
      addSection("Adresse BDNB", cleanRows(data.address || {}), palette.neutral);

      const trace = `BDNB ${bdnbVintage} · RPLS 2024 · RNB API courante · Cadastre PCI Express via API Carto · DVF+ Cerema · Sitadel SDES lorsque des dossiers sont rapprochés. Fiche générée le ${generated}. Les données constituent une aide à l’analyse et doivent être vérifiées avant toute décision administrative individuelle.`;
      addSection("Millésimes et traçabilité", [["Sources et versions", trace]], palette.identity);

      const totalPages = doc.getNumberOfPages();
      for (let page = 1; page <= totalPages; page++) {
        doc.setPage(page);
        addFooter(page);
      }

      const pdfBlob = doc.output("blob");
      const pdfUrl = URL.createObjectURL(pdfBlob);
      previewWindow.location.replace(pdfUrl);
      setTimeout(() => URL.revokeObjectURL(pdfUrl), 10 * 60 * 1000);
    } catch (error) {
      try { previewWindow.close(); } catch (_) {}
      console.error("Export PDF", error);
      alert(`La création du PDF a échoué : ${error.message}`);
    } finally {
      button.classList.remove("loading");
      button.textContent = "Ouvrir la fiche PDF";
    }
  }

  async function captureRealMap() {
    if (!state.selectedFeature) throw new Error("Aucun bâtiment sélectionné");

    const oldCenter = map.getCenter();
    const oldZoom = map.getZoom();
    const mapElement = document.getElementById("map");
    const mapCard = document.querySelector(".map-card");

    const bounds = L.geoJSON({
      type: "FeatureCollection",
      features: [
        ...state.parcels,
        state.selectedFeature
      ].filter(Boolean)
    }).getBounds();

    mapCard.classList.add("map-capture-mode");

    try {
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(.35), { maxZoom: 19, animate: false });
      }
      map.invalidateSize(false);
      await waitForTiles(2400);
      await new Promise(resolve => setTimeout(resolve, 700));

      if (window.leafletImage) {
        try {
          const canvas = await new Promise((resolve, reject) => {
            leafletImage(map, (error, result) => error ? reject(error) : resolve(result));
          });
          if (canvas && canvas.width > 0) {
            return {
              dataUrl: canvas.toDataURL("image/png"),
              width: canvas.width,
              height: canvas.height
            };
          }
        } catch (error) {
          console.warn("leaflet-image", error);
        }
      }

      if (!window.html2canvas) throw new Error("Aucun moteur de capture disponible");
      const canvas = await html2canvas(mapElement, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#eef1f4",
        scale: 1.45,
        logging: false
      });
      return {
        dataUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height
      };
    } finally {
      map.setView(oldCenter, oldZoom, { animate: false });
      map.invalidateSize(false);
      mapCard.classList.remove("map-capture-mode");
    }
  }

  function waitForTiles(timeout = 1600) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        map.off("load", finish);
        resolve();
      };
      map.once("load", finish);
      setTimeout(finish, timeout);
    });
  }

  async function search(query) {
    live("", "Recherche en cours", query);
    progress(20);

    try {
      if (/^[A-Z0-9]{8,20}$/i.test(query) && !query.includes(" ")) {
        const feature = await getJSON(`${CFG.rnbBuilding}/${encodeURIComponent(query.toUpperCase())}/`);
        zoomToFeature(feature);
        state.selectedFeature = feature;
        state.selectedRnbId = featureRnbId(feature);
        openLocalBuilding(feature);
        await loadBdnb(state.selectedRnbId);
      } else {
        const data = await getJSON(`${CFG.rnbAddress}?q=${encodeURIComponent(query)}`);
        const feature = data?.features?.[0] || data?.results?.[0] || data?.[0];
        if (!feature) throw new Error("Aucun bâtiment trouvé pour cette adresse.");
        const normalized = feature.type === "Feature" ? feature : {
          type: "Feature",
          id: feature.rnb_id || feature.id,
          geometry: feature.shape || feature.geometry || feature.point,
          properties: feature
        };
        zoomToFeature(normalized);
        state.selectedFeature = normalized;
        state.selectedRnbId = featureRnbId(normalized);
        openLocalBuilding(normalized);
        await loadBdnb(state.selectedRnbId);
      }
    } catch (error) {
      live("ko", "Recherche impossible", error.message);
      progress(0);
      alert(error.message);
    }
  }

  function zoomToFeature(feature) {
    const layer = L.geoJSON(feature);
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(.8), { maxZoom: 18 });
  }

  map.on("moveend", () => {
    clearTimeout(state.loadTimer);
    state.loadTimer = setTimeout(loadVisibleBuildings, 250);
  });

  $("#search-form").addEventListener("submit", event => {
    event.preventDefault();
    const query = $("#search-input").value.trim();
    if (query) search(query);
  });

  $("#drawer-close").addEventListener("click", () => $("#drawer").classList.remove("open"));
  $("#btn-export").addEventListener("click", exportBuildingSheet);

  $("#about-close").addEventListener("click", () => $("#about-modal").hidden = true);
  $("#about-modal").addEventListener("click", event => {
    if (event.target === $("#about-modal")) $("#about-modal").hidden = true;
  });
  $("#btn-buildings").addEventListener("click", () => {
    const center = map.getCenter();
    map.setView(center, Math.max(17, map.getZoom()), { animate: true });
    setTimeout(loadVisibleBuildings, 350);
    live("", "Zoom bâtiment activé", "cliquez sur une emprise orange");
  });

  $("#btn-locate").addEventListener("click", () => {
    map.locate({ setView: true, maxZoom: 18 });
  });

  loadMetadata();
  loadVisibleBuildings();
})();
