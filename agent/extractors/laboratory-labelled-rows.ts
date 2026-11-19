/** Convert explicitly labelled laboratory blocks into rows without inferring a marker or a value. */
export function laboratorySourceLines(text: string): {lines:string[];flags:Map<string,'H'|'L'|'NORMAL'>} {
  const lines: string[]=[];
  const flags=new Map<string,'H'|'L'|'NORMAL'>();
  const marker=/^(?:bepaling|testnaam|test(?: name)?|prueba|an[aá]lisis|marcador|marker|examen|analyse|param[eè]tre|untersuchung|parameter|par[aâ]metro|exame|teste)\s*:\s*(.+)$/iu;
  const result=/^(?:uitslag|resultaat|resultado|result|r[eé]sultat|ergebnis|valor|waarde|value|wert|valeur)\s*:\s*(.+)$/iu;
  const unit=/^(?:eenheid|unidad|unit|unit[eé]|einheit|unidade|unidat)\s*:\s*(.+)$/iu;
  const reference=/^(?:referentiewaarden?|referentie(?:waarde)?|reference(?: range)?|rango(?: de referencia)?|referencia|r[eé]f[eé]rence|plage de r[eé]f[eé]rence|referenz(?:bereich|werte)?|intervalo(?: de refer[eê]ncia)?|faixa(?: de refer[eê]ncia)?|rango di referensia)\s*:\s*(.*)$/iu;
  const flag=/^(?:laboratorium markering|markering|flag|marca|markierung|sinaliza[cç][aã]o)\s*:\s*(.*)$/iu;
  let block:{marker:string;result?:string;unit?:string;reference?:string;flag?:'H'|'L'|'NORMAL';invalid?:boolean}|undefined;
  const assign=(key:'result'|'unit'|'reference',value:string)=>{if(!block)return;if(block[key]!==undefined&&block[key]!==value)block.invalid=true;else block[key]=value;};
  const flush=()=>{
    if(block&&!block.invalid&&block.result){
      const value=/^((?:[<>]=?\s*)?-?\d+(?:[.,]\d+)?)(?:\s+([^\r\n]+))?$/u.exec(block.result);
      const range=block.reference? /^([<>]=?\s*-?\d+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?\s*[-–]\s*-?\d+(?:[.,]\d+)?)(?:\s+([^\r\n]+))?$/u.exec(block.reference):null;
      const sourceUnit=value?.[2]?.trim()||block.unit;
      const consistentUnit=(!value?.[2]||!block.unit||value[2].trim()===block.unit)&&(!range?.[2]||!sourceUnit||range[2].trim()===sourceUnit);
      if(value&&consistentUnit&&(!block.reference||range)){
        const row=[block.marker,value[1],sourceUnit,range?.[1].replace('–','-')].filter(Boolean).join(' ');
        lines.push(row);if(block.flag)flags.set(row,block.flag);
      }
    }
    block=undefined;
  };
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();let match:RegExpExecArray|null;
    if((match=marker.exec(line))){flush();if(/\s[<>]?\d+(?:[.,]\d+)?\s+\S/u.test(match[1]))lines.push(match[1]);else block={marker:match[1].trim()};}
    else if((match=result.exec(line)))assign('result',match[1].trim());
    else if((match=unit.exec(line)))assign('unit',match[1].trim());
    else if((match=reference.exec(line)))assign('reference',match[1].trim());
    else if((match=flag.exec(line))){
      if(block){const normalized=match[1].normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim();const reported=/^(?:h|high|hoog|alto|eleve|hoch|altu)$/.test(normalized)?'H':/^(?:l|low|laag|bajo|bas|niedrig|baixo|abou)$/.test(normalized)?'L':/^(?:normal|normaal|normale)$/.test(normalized)?'NORMAL':undefined;
        if(reported){if(block.flag&&block.flag!==reported)block.invalid=true;else block.flag=reported;}}
    }
    else if(!line){flush();}
    else{flush();lines.push(line);}
  }
  flush();return {lines,flags};
}
