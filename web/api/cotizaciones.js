// Vercel Node.js Function. Credentials are read only on the server.
const NUMBER_FIELD='N˚ Cotización';
const ID_FIELD='ID Cotización';

module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'){
    res.setHeader('Allow','POST');
    return res.status(405).json({error:'Método no permitido.'});
  }
  const {AIRTABLE_TOKEN,AIRTABLE_BASE_ID,AIRTABLE_TABLE_ID}=process.env;
  if(!AIRTABLE_TOKEN||!AIRTABLE_BASE_ID||!AIRTABLE_TABLE_ID){
    return res.status(503).json({error:'Falta configurar la conexión con Airtable en Vercel.'});
  }
  // Reject cross-origin browser submissions; there is no public CORS endpoint.
  const origin=req.headers.origin;
  const host=req.headers['x-forwarded-host']||req.headers.host;
  if(origin){
    try{if(new URL(origin).host!==host)return res.status(403).json({error:'Origen no permitido.'});}
    catch{return res.status(403).json({error:'Origen no permitido.'});}
  }
  let body;
  try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}
  catch{return res.status(400).json({error:'Datos inválidos.'});}
  const q=body?.quote,requestId=body?.requestId;
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
    !Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(!q||!/^[-a-f0-9]{36}$/.test(requestId||'')||
    !['nac','int'].includes(q.market)||!validDate(q.arrival)||!validDate(q.departure)||
    q.departure<=q.arrival||!Number.isFinite(q.total)||q.total<0||
    !['full','single','nonangler'].every(key=>Number.isInteger(q[key])&&q[key]>=0&&q[key]<=100)||
    q.full+q.single+q.nonangler<1||
    typeof q.quoter!=='string'||q.quoter.length>200||
    typeof q.email!=='string'||q.email.length>254||
    !Array.isArray(q.breakdown)||JSON.stringify(q).length>20000){
    return res.status(400).json({error:'Revisa las fechas, los participantes y los datos de la cotización.'});
  }
  const endpoint=`https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE_ID)}`;
  const headers={Authorization:`Bearer ${AIRTABLE_TOKEN}`,'Content-Type':'application/json'};
  const marker=`GBL-PDF:${requestId}`;
  const result=record=>{
    const internalNumber=record?.fields?.[NUMBER_FIELD];
    const number=internalNumber+69;
    if(!Number.isSafeInteger(internalNumber)||internalNumber<1)throw new Error('missing_number');
    return {recordId:record.id,number,id:record.fields[ID_FIELD]||`Cotización Nº${number}`};
  };
  try{
    // A retry after a lost response recovers the record instead of consuming a number.
    const lookup=new URL(endpoint);
    lookup.searchParams.set('filterByFormula',`FIND("${marker}", {Notas})`);
    lookup.searchParams.set('maxRecords','1');
    const found=await fetch(lookup,{headers,signal:AbortSignal.timeout(15000)});
    if(!found.ok)throw new Error(`airtable_${found.status}`);
    const existing=await found.json();
    if(existing.records?.length)return res.status(200).json(result(existing.records[0]));
    const currency=q.market==='nac'?'CLP':'USD';
    const notes=[marker,`Cotizante: ${q.quoter||'Sin nombre'}`,`Email: ${q.email||'No indicado'}`,
      `Mercado: ${q.market==='nac'?'Nacional':'Internacional'} (${currency})`,
      `Precio final: ${q.total} ${currency}`,
      'Datos de la calculadora:',JSON.stringify(q,null,2)].join('\n');
    const created=await fetch(endpoint,{
      method:'POST',headers,signal:AbortSignal.timeout(20000),
      body:JSON.stringify({records:[{fields:{
        'Fecha tentativa de llegada':q.arrival,
        'Fecha tentativa de salida':q.departure,
        'N˚ de personas':q.full+q.single+q.nonangler,
        'Precio cotizado':q.total,
        'Temporada':process.env.AIRTABLE_SEASON||'26/27',
        'Notas':notes
      }}]})
    });
    if(!created.ok)throw new Error(`airtable_${created.status}`);
    const data=await created.json();
    return res.status(201).json(result(data.records?.[0]));
  }catch(error){
    // Never expose credentials, personal data, or Airtable's response body.
    console.error('Registro de cotización:',error.name,error.message);
    return res.status(502).json({error:'No se pudo confirmar el registro en Airtable. Reintenta con los mismos datos para recuperar la cotización.'});
  }
};
