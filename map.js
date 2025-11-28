// --- API KEY! ---
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjY4ZGFmNzAwOTkxZDRkMTU4MjI5MzhmNGQ5MGU1ZGE5IiwiaCI6Im11cm11cjY0In0=";
// ----------------------------------------------------------

let map = L.map('map').setView([14.676, 121.0437], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OSM'
}).addTo(map);

let markers = [], routeLine = null;

// ========== Drop-off UI helpers ==========
let dropoffCounter = 0;
function addDropoffRow(address = '', weight = '') {
  const container = document.getElementById('dropoffsContainer');
  const id = `dropoff-${++dropoffCounter}`;

  const row = document.createElement('div');
  row.className = 'dropoff-row';
  row.id = id;

  const addrInput = document.createElement('input');
  addrInput.type = 'text';
  addrInput.placeholder = 'Drop-off address (e.g., 10 Tandang Sora)';
  addrInput.value = address;
  addrInput.className = 'addr-input';

  const wtInput = document.createElement('input');
  wtInput.type = 'number';
  wtInput.min = '0';
  wtInput.step = '0.1';
  wtInput.placeholder = 'kg';
  wtInput.value = weight;
  wtInput.style.maxWidth = '90px';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'mini-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.onclick = () => {
    container.removeChild(row);
  };

  row.appendChild(addrInput);
  row.appendChild(wtInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function clearAll() {
  // clear inputs and map
  document.getElementById('pickup').value = '';
  document.getElementById('defaultWeight').value = '';
  document.getElementById('routePref').value = 'fastest';
  const container = document.getElementById('dropoffsContainer');
  container.innerHTML = '';
  dropoffCounter = 0;
  addDropoffRow();
  document.getElementById('output').textContent = '';
  if (markers.length) { markers.forEach(m => map.removeLayer(m)); markers = []; }
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
}

// ========== Geocoding & ORS routing ==========
async function geocode(address) {
  // Use Nominatim for geocoding
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address + ', Quezon City, Philippines')}`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return null;
    const data = await response.json();
    if (data && data[0]) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        display: data[0].display_name
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Accepts an ordered array of [lat, lng] pairs (pickup first, then drop-offs)
// preference: 'fastest' or 'shortest'
async function fetchORSRoute(multiCoordsLatLng, preference = 'fastest') {
  const url = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
  const headers = {
    "Authorization": ORS_API_KEY,
    "Accept": "application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8",
    "Content-Type": "application/json"
  };

  // Convert to ORS expected [[lon, lat], ...]
  const coords = multiCoordsLatLng.map(c => [c[1], c[0]]);
  const body = JSON.stringify({
    coordinates: coords,
    preference: preference,
    instructions: false, // we don't need detailed turn-by-turn here
    geometry: true
  });

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    // Try to provide more info if available
    const txt = await res.text().catch(() => '');
    console.error('ORS error response:', res.status, txt);
    return null;
  }
  return res.json();
}

// ========== Main routing logic ==========
window.setRoute = async function setRoute() {
  const pickupAddr = document.getElementById('pickup').value.trim();
  const routePref = document.getElementById('routePref').value;
  const defaultWeightValRaw = document.getElementById('defaultWeight').value.trim();
  const defaultWeightVal = defaultWeightValRaw === '' ? null : parseFloat(defaultWeightValRaw);

  document.getElementById('output').textContent = 'Loading...';

  if (markers.length) { markers.forEach(m => map.removeLayer(m)); markers = []; }
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  // Collect drop-offs from UI
  const dropoffRows = Array.from(document.querySelectorAll('#dropoffsContainer .dropoff-row'));
  if (!pickupAddr) {
    document.getElementById('output').textContent = "Please input a pickup address.";
    return;
  }
  if (dropoffRows.length === 0) {
    document.getElementById('output').textContent = "Please add at least one drop-off.";
    return;
  }

  const dropoffs = dropoffRows.map(row => {
    const addr = row.querySelector('.addr-input').value.trim();
    const wtRaw = row.querySelector('input[type="number"]').value.trim();
    const wt = wtRaw === '' ? null : parseFloat(wtRaw);
    return { address: addr, weight: wt };
  });

  // Validate at least addresses present
  for (let i = 0; i < dropoffs.length; i++) {
    if (!dropoffs[i].address) {
      document.getElementById('output').textContent = `Drop-off #${i + 1} has no address.`;
      return;
    }
  }

  // Geocode pickup + all dropoffs in parallel
  document.getElementById('output').textContent = "Geocoding addresses...";
  const geocodePromises = [geocode(pickupAddr), ...dropoffs.map(d => geocode(d.address))];
  const geocoded = await Promise.all(geocodePromises);

  if (geocoded.some(g => g === null)) {
    const failedIndex = geocoded.findIndex(g => g === null);
    if (failedIndex === 0) {
      document.getElementById('output').textContent = "Unable to locate the pickup address. Try to be more specific.";
    } else {
      document.getElementById('output').textContent = `Unable to locate drop-off #${failedIndex}. Try to be more specific.`;
    }
    return;
  }

  // Build arrays we'll use
  const coordsLatLng = geocoded.map(g => [g.lat, g.lng]); // ordered: pickup, drop1, drop2...
  const displayNames = geocoded.map(g => g.display);

  // For weights: use per-dropoff weight if set, otherwise fallback to defaultWeightVal, otherwise 0
  const dropoffWeights = dropoffs.map(d => {
    if (d.weight !== null && !isNaN(d.weight) && d.weight >= 0) return d.weight;
    if (defaultWeightVal !== null && !isNaN(defaultWeightVal) && defaultWeightVal >= 0) return defaultWeightVal;
    return 0;
  });

  // Add markers for pickup and dropoffs
  const markerPickup = L.marker(coordsLatLng[0], { title: 'Pickup', icon: greenIcon() }).addTo(map).bindPopup('Pickup:<br>' + displayNames[0]);
  markers.push(markerPickup);
  for (let i = 1; i < coordsLatLng.length; i++) {
    const mk = L.marker(coordsLatLng[i], { title: `Drop-off ${i}`, icon: redIcon() }).addTo(map).bindPopup(`Drop-off ${i}:<br>${displayNames[i]}<br>Weight: ${dropoffWeights[i - 1]} kg`);
    markers.push(mk);
  }

  // Fetch route from ORS (will route in the provided order)
  document.getElementById('output').textContent = "Calculating route...";
  const ors = await fetchORSRoute(coordsLatLng, routePref);
  if (!ors || !ors.features || !ors.features[0]) {
    document.getElementById('output').textContent = "No driving route found or ORS request failed.";
    return;
  }

  // Draw route polyline
  const routeCoords = ors.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
  routeLine = L.polyline(routeCoords, { color: '#219150', weight: 5, opacity: 0.85 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });

  // ORS returns segments: an array with each leg between waypoints
  // segments[i] corresponds to the leg from waypoint i to waypoint i+1
  const segments = (ors.features[0].properties && ors.features[0].properties.segments) || [];
  // fallback: total summary if segments missing
  const totalDistanceMeters = (ors.features[0].properties && ors.features[0].properties.summary && ors.features[0].properties.summary.distance) || 0;
  const totalDurationSec = (ors.features[0].properties && ors.features[0].properties.summary && ors.features[0].properties.summary.duration) || 0;

  // Cost calculation that accounts for changing load after each drop-off.
  // Assume vehicle starts loaded with all drop-off packages.
  const BASE_RATE = 20;       // 20 PHP per km
  const WEIGHT_RATE = 5;      // 5 PHP per km per kg

  let totalCost = 0;
  let breakdownLines = [];

  // initial load is sum of all dropoff weights
  let currentLoad = dropoffWeights.reduce((s, x) => s + x, 0);

  if (segments.length > 0) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segDistKm = seg.distance / 1000;
      const segDurationMin = Math.round(seg.duration / 60);

      // cost for this segment is distance * (base + weight_rate * currentLoad)
      const segCost = segDistKm * (BASE_RATE + (WEIGHT_RATE * currentLoad));
      totalCost += segCost;

      // record breakdown: segment from waypoint i -> i+1
      const fromName = (i === 0) ? 'Pickup' : `Drop-off ${i}`;
      const toName = `Drop-off ${i + 1}`;
      breakdownLines.push({
        from: fromName,
        to: toName,
        dist_km: segDistKm.toFixed(2),
        dur_min: segDurationMin,
        load_before_kg: currentLoad.toFixed(2),
        cost: segCost.toFixed(2)
      });

      // after arriving at waypoint i+1, if it's a drop-off, reduce load by that drop-off's weight
      // coordinates index mapping: waypoint 0 = pickup; waypoint 1 = dropoff[0], waypoint 2 = dropoff[1], ...
      const arrivedWaypointIndex = i + 1;
      if (arrivedWaypointIndex >= 1) {
        // subtract corresponding dropoff weight (arrivedWaypointIndex - 1)
        const removedWeight = dropoffWeights[arrivedWaypointIndex - 1] || 0;
        currentLoad = Math.max(0, currentLoad - removedWeight);
      }
    }
  } else {
    // fallback: single leg only, use summary distance
    const distKm = totalDistanceMeters / 1000;
    totalCost = distKm * (BASE_RATE + (WEIGHT_RATE * currentLoad));
    breakdownLines.push({
      from: 'Pickup',
      to: `Drop-off(s)`,
      dist_km: distKm.toFixed(2),
      dur_min: Math.round(totalDurationSec / 60),
      load_before_kg: currentLoad.toFixed(2),
      cost: totalCost.toFixed(2)
    });
  }

  const totalDistanceKm = (totalDistanceMeters / 1000).toFixed(2);
  const totalDurationMin = Math.round(totalDurationSec / 60);
  totalCost = totalCost.toFixed(2);

  // Present results with breakdown
  let outputHtml = `<b>Route (${routePref === "fastest" ? "Fastest (Shortest Time)" : "Shortest (Shortest Distance)"}):</b><br>
    <b>From:</b> ${displayNames[0]}<br>
    <b>To (final):</b> ${displayNames[displayNames.length - 1]}<br>
    <b>Total Road Distance:</b> ${totalDistanceKm} km<br>
    <b>Estimated Driving Time:</b> ${totalDurationMin} min<br>
    <b>Total Estimated Cost:</b> <span style="color:#219150"><b>₱${totalCost}</b></span>
    <div class="breakdown"><b>Segment breakdown:</b><br>`;

  breakdownLines.forEach((b, idx) => {
    outputHtml += `<div style="margin-top:6px;"><b>Leg ${idx + 1}:</b> ${b.from} → ${b.to}<br>
      Distance: ${b.dist_km} km • Time: ${b.dur_min} min<br>
      Load before leg: ${b.load_before_kg} kg • Cost: ₱${b.cost}</div>`;
  });

  outputHtml += `</div>`;

  document.getElementById('output').innerHTML = outputHtml;
};

// Simple colored icons for pickup & dropoff
function greenIcon() {
  return new L.Icon({
    iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-green.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });
}
function redIcon() {
  return new L.Icon({
    iconUrl: 'https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-red.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });
}
